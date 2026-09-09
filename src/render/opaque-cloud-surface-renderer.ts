// 積雲(雲の場の R = 被覆率、G = 雲頂高度)を、地表の上に立つ不透明な雲として描くメッシュ。
// 分割段ラダーの各段ぶんの球を1枚のマテリアルで束ね、見かけ直径に応じて1段だけを見せる。殻の面へ
// 届いた視線は雲頂の高さ場まで下ろして交点を探し、そこの深度と法線を書く。場の texel より細かい
// 粒は天体固定のノイズで足す。陰影・影・逆二乗の減衰はすべてパイプラインが与える。
import * as THREE from 'three/webgpu';
import {
  Discard, Fn, If, cameraPosition, cameraProjectionMatrix, dFdx, dFdy, dot, float, length,
  max, mix, modelViewMatrix, modelWorldMatrixInverse, normalize, positionLocal, select, smoothstep,
  sqrt, transformNormalToView, uniform, vec3, vec4,
} from 'three/tsl';
import { CloudShapeEvaluator } from './cloud/cloud-shape-evaluator';
import type { CloudFieldSampler } from './cloud/cloud-field-sampler';
import { unitSphereGeometry } from './celestial-surface';
import { CLOUD_ALBEDO, CLOUD_TOP_SPAN, CUMULUS_GRAIN_SIZE } from './cloud/cumulus-shape';
import { eastAt, northAt } from './cloud/sphere-frame';
import { markLitOpaque } from './pipeline/lit-layer';
import { sphereLodLevel, SPHERE_LOD_LADDER, SphereLodLevel } from './screen-lod';
import type { FloatNode, FloatUniform, Vec3Node, Vec4Node } from './tsl-types';

// 雲の粗さ。雲は拡散する面なので、粗さは最大になる。
const CUMULUS_ROUGHNESS = 1;

// 積雲の精細さの段。オフは殻を描かない段。**値は保存された設定を読む鍵なので、段を足すときも
// 既存の値を動かさない** — 番号を詰め直すと、保存済みの設定が黙って別の段を指す。
export const CUMULUS_DETAIL = { off: 0, coarse: 1, standard: 2, fine: 3 } as const;
export type CumulusDetail = (typeof CUMULUS_DETAIL)[keyof typeof CUMULUS_DETAIL];

// 雲頂を探す標本の配り方。march は殻の中を等間隔にたどる刻みの数(どの交点を見つけるかを決める)、
// refine は雲頂をまたいだ区間を締める回数(最初は clearance の線形補間、残りは二分で精度を決める)。
type CumulusSampling = { readonly march: number; readonly refine: number };

// 段ごとの標本の配り方。費用は入口の1回 + march + refine 回の標本化。march 0 は殻を描かない。
// **いちばん粗い段は march 1 本に留め、そのぶん refinement を増やす** — 刻みが 2 本以上あると手前と奥で
// 拾った雲頂が 2 枚の層として重なって読める。線形補間で最初の交点を寄せてから締めるので、区間が
// 殻の端から端まで広がる段でも、雲頂が深さの段へ割れて縞に見える量を抑えられる。
const SAMPLING_OF_DETAIL = {
  [CUMULUS_DETAIL.off]: { march: 0, refine: 0 },
  [CUMULUS_DETAIL.coarse]: { march: 1, refine: 5 },
  [CUMULUS_DETAIL.standard]: { march: 6, refine: 3 },
  [CUMULUS_DETAIL.fine]: { march: 12, refine: 3 },
} as const satisfies Readonly<Record<CumulusDetail, CumulusSampling>>;

// 粒の 1 波長が何画素を切ったら消し始め、何画素まで残すか。標本化できない粒はモアレにしか
// ならないので、Nyquist の 2 画素へ落ちるまでに振幅を 0 へ渡す。
const GRAIN_FADE_MIN_PIXELS = 2;
const GRAIN_FADE_FULL_PIXELS = 4;

export class OpaqueCloudSurfaceRenderer {
  private readonly shape: CloudShapeEvaluator;
  // 標本の配り方と、その回数まで展開したマテリアル。
  private sampling: CumulusSampling = SAMPLING_OF_DETAIL[CUMULUS_DETAIL.standard];
  private material: THREE.Material;
  // 殻を半径 1 とする物体空間での地表の半径。レイマーチの下端になる。**天体ごとに違う値は
  // uniform で渡す** — グラフへ焼くと、殻を持つ天体の数だけシェーダが増える。
  private readonly groundRadius: FloatUniform;
  // 粒の 1 rad あたりの山の数と、雲頂の勾配を測る差分の幅 [rad]。差分は粒の半波長ぶんなので、
  // 場の起伏と粒の起伏が同じ 1 つの法線に出る。
  private readonly grainFrequency: FloatUniform;
  private readonly gradientAngle: FloatUniform;
  // 段ごとの球。表示側が親の位置・スケール・自転姿勢を毎フレーム与える。
  private readonly meshes: ReadonlyMap<SphereLodLevel, THREE.Mesh>;
  private activeLevel: SphereLodLevel | null = null;

  // fieldSampler は共有雲場、bodyRadius は殻を載せる天体の基準半径 [m]。親は半径 bodyRadius の
  // 球へ合わせたスケールを与えればよく、雲頂ぶんの膨らみはこの renderer が持つ。
  public constructor(private readonly fieldSampler: CloudFieldSampler, bodyRadius: number) {
    // 雲頂を含む殻の尺度と雲粒の周波数を組む。
    const shellScale = 1 + CLOUD_TOP_SPAN / bodyRadius;
    const grainFrequency = bodyRadius / CUMULUS_GRAIN_SIZE;
    this.groundRadius = uniform(1 / shellScale);
    this.grainFrequency = uniform(grainFrequency);
    this.shape = new CloudShapeEvaluator(this.grainFrequency);
    this.gradientAngle = uniform(0.5 / grainFrequency);
    this.material = this.buildMaterial();

    // 詳細度ごとのメッシュを同じ雲場へ束ねる。
    const meshes = new Map<SphereLodLevel, THREE.Mesh>();
    for (const level of SPHERE_LOD_LADDER) {
      const mesh = new THREE.Mesh(unitSphereGeometry(level), this.material);
      mesh.scale.setScalar(shellScale);
      mesh.visible = false;
      markLitOpaque(mesh);
      meshes.set(level, mesh);
    }
    this.meshes = meshes;
  }

  // 殻を描いている段があるか。
  public get visible(): boolean { return this.activeLevel !== null; }

  // 殻の高度 [m]。場の雲頂高度 0..1 が張る高さでもある。
  public get topAltitude(): number { return CLOUD_TOP_SPAN; }

  // 全段のメッシュを parent の下へ置く。
  public addTo(parent: THREE.Object3D): void {
    for (const mesh of this.meshes.values()) parent.add(mesh);
  }

  // 積雲の精細さの段を置き直す。
  public setDetail(detail: CumulusDetail): void {
    this.setSampling(SAMPLING_OF_DETAIL[detail]);
  }

  // 標本の配り方を置き直す。**回数はレイマーチの展開としてグラフへ焼かれている**ので、
  // 変わったらマテリアルを組み直して全段のメッシュへ張り替える。
  private setSampling(sampling: CumulusSampling): void {
    if (sampling.march === this.sampling.march && sampling.refine === this.sampling.refine) return;
    this.sampling = sampling;
    const previous = this.material;
    this.material = this.buildMaterial();
    for (const mesh of this.meshes.values()) mesh.material = this.material;
    previous.dispose();
  }

  // 見かけ直径 [px] から分割段を選び、その段のメッシュだけを見せる。刻みを持たない配り方では
  // 全段を隠す。
  public syncLod(apparentDiameterPx: number): void {
    const level = this.sampling.march === 0 ? null : sphereLodLevel(apparentDiameterPx);
    if (level === this.activeLevel) return;
    this.activeLevel = level;
    for (const [meshLevel, mesh] of this.meshes) mesh.visible = meshLevel === level;
  }

  // 全段のメッシュを隠す。次の syncLod で段を選び直す。
  public hide(): void {
    this.activeLevel = null;
    for (const mesh of this.meshes.values()) mesh.visible = false;
  }

  // 全段のメッシュを親から外し、表面専用のマテリアルを解放する。雲場は CloudPresentation が解放する。
  public dispose(): void {
    for (const mesh of this.meshes.values()) mesh.removeFromParent();
    this.material.dispose();
  }

  // 雲頂の交点を書く不透明な白の標準マテリアル。深度と法線は 1 本のレイマーチを共有する。
  private buildMaterial(): THREE.Material {
    const material = new THREE.MeshStandardNodeMaterial({
      roughness: CUMULUS_ROUGHNESS, metalness: 0,
    });
    const marched = this.marchedSurface().toVar();
    material.depthNode = marched.w;
    material.normalNode = marched.xyz;
    material.colorNode = vec3(CLOUD_ALBEDO);
    return material;
  }

  // 殻の面へ届いた視線を雲頂の高さ場へ下ろし、交点の view 空間法線(xyz)と深度(w)を返す。
  //
  // **標本化は分岐の外で済ませ、捨てるのは最後にする** — テクスチャのミップ段は隣接画素との
  // 差から決まるので、条件分岐や discard のあとで読むと段が決まらない。
  private marchedSurface(): Vec4Node {
    return Fn(() => {
      const entry = positionLocal.toVar();
      const origin = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;
      const direction = normalize(entry.sub(origin)).toVar();
      const grainAmplitude = this.grainAmplitudeAt(normalize(entry)).toVar();

      // 殻に入ってから地表の球へ達するまで(掠めるなら殻を出るまで)を等分してたどる。
      const along = dot(entry, direction);
      const half = along.mul(along).sub(dot(entry, entry));
      const groundHalf = half.add(this.groundRadius.mul(this.groundRadius));
      const marchEnd = max(select(
        groundHalf.greaterThan(0),
        along.negate().sub(sqrt(max(groundHalf, 0))),
        along.negate().add(sqrt(max(half.add(1), 0))),
      ), 0);
      const sampling = this.sampling;
      const stepLength = marchEnd.div(sampling.march);

      // 雲頂より内側へ入った最初の刻みを、その手前の刻みと clearance と一緒に覚える。
      const hit = float(0).toVar();
      const above = float(0).toVar();
      const below = marchEnd.toVar();
      const aboveClearance = float(1).toVar();
      const belowClearance = float(0).toVar();
      const previousDistance = float(0).toVar();
      const previousClearance = this.clearanceAt(entry, grainAmplitude).toVar();
      for (let stepIndex = 1; stepIndex <= sampling.march; stepIndex++) {
        const distance = stepLength.mul(stepIndex);
        const clearance = this.clearanceAt(entry.add(direction.mul(distance)), grainAmplitude).toVar();
        const inside = clearance.lessThan(0);
        If(inside.and(hit.lessThan(0.5)), () => {
          hit.assign(1);
          above.assign(previousDistance);
          below.assign(distance);
          aboveClearance.assign(previousClearance);
          belowClearance.assign(clearance);
        });
        If(hit.lessThan(0.5), () => {
          previousDistance.assign(distance);
          previousClearance.assign(clearance);
        });
      }
      // 最初は前後の clearance を線形補間し、残りは区間を二分して縁を締める。単純な中点だけで
      // 交点を選ぶと、視線の区間数に応じた深度の段がそのまま雲頂の縞になる。
      for (let refineIndex = 0; refineIndex < sampling.refine; refineIndex++) {
        const denominator = max(aboveClearance.sub(belowClearance), 1e-6);
        const linearWeight = aboveClearance.div(denominator).clamp(0, 1);
        const middle = (refineIndex === 0)
          ? mix(above, below, linearWeight)
          : above.add(below).mul(0.5);
        const clearance = this.clearanceAt(entry.add(direction.mul(middle)), grainAmplitude).toVar();
        If(clearance.lessThan(0), () => {
          below.assign(middle);
          belowClearance.assign(clearance);
        }).Else(() => {
          above.assign(middle);
          aboveClearance.assign(clearance);
        });
      }

      const hitPoint = entry.add(direction.mul(below)).toVar();
      const clip = cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(hitPoint, 1)));
      const viewNormal = normalize(transformNormalToView(this.cloudTopNormalAt(hitPoint, grainAmplitude)));
      const cloud = this.fieldAt(normalize(hitPoint)).toVar();
      const grain = this.shape.grainAt(normalize(hitPoint), grainAmplitude);
      const opaqueFraction = this.shape.opaqueFraction(cloud.r, grain);
      // 交差探索は連続な雲頂で済ませ、最後の表示判定だけを被覆率の中心で切る。画素ごとの
      // blue noise をここへ入れると、探索の符号が視線上で飛び、深度の等高線になる。
      Discard(hit.lessThan(0.5).or(opaqueFraction.lessThan(0.5)));
      return vec4(viewNormal, clip.z.div(clip.w));
    })();
  }

  // 物体空間の点が、その柱の雲頂からどれだけ外に居るか。負なら雲の中。
  private clearanceAt(point: Vec3Node, grainAmplitude: FloatNode): FloatNode {
    const radius = max(length(point), 1e-6);
    const direction = point.div(radius);
    const cloud = this.fieldAt(direction);
    const grain = this.shape.grainAt(direction, grainAmplitude);
    // 被覆率 0 では雲頂を地表へ戻し、被覆率 1 では本来の雲頂へ戻す。探索中に柱を二値化
    // しないので、雲の縁でも clearance が連続し、線形補間と二分探索の前提を保てる。
    const opaqueFraction = this.shape.opaqueFraction(cloud.r, grain);
    const cloudTop = this.shape.cloudTop(cloud.g, grain).mul(opaqueFraction);
    return radius.sub(this.shape.cloudTopRadius(cloudTop, this.groundRadius));
  }

  // 交点における雲頂面の法線(物体空間)。**被覆率は連続な雲頂へ含める** — 柱ごとに二値で断ち切った
  // 崖ではなく、被覆の境界から本来の雲頂へ渡る起伏を法線に出す。
  private cloudTopNormalAt(hitPoint: Vec3Node, grainAmplitude: FloatNode): Vec3Node {
    const up = hitPoint.div(max(length(hitPoint), 1e-6));
    const east = eastAt(up);
    const north = northAt(up);
    // その向きの雲頂(物体空間の半径)。
    const topAt = (direction: Vec3Node): FloatNode => {
      const cloud = this.fieldAt(direction);
      const grain = this.shape.grainAt(direction, grainAmplitude);
      return this.shape.cloudTopRadius(
        this.shape.cloudTop(cloud.g, grain).mul(this.shape.opaqueFraction(cloud.r, grain)),
        this.groundRadius,
      );
    };
    // **中心の高さは交点の中心距離ではなく雲頂を引き直して測る** — 締めた交点は雲頂より内側へ
    // 食い込んでいて、中心距離を高さに使うと食い込みが両方向の傾きへ同じ下駄として乗る。掠める
    // 視線ほど刻みが長く食い込みも深いので、リム際で法線が倒れて夜側の雲が光る。
    const here = topAt(up);
    // 東と北へ粒の半波長ぶん振った雲頂との差が、そのまま接平面での傾き。
    const slopeEast = topAt(normalize(up.add(east.mul(this.gradientAngle))))
      .sub(here).div(this.gradientAngle);
    const slopeNorth = topAt(normalize(up.add(north.mul(this.gradientAngle))))
      .sub(here).div(this.gradientAngle);
    return normalize(up.sub(east.mul(slopeEast)).sub(north.mul(slopeNorth)));
  }

  // 天体固定の単位方向における場の値。
  private fieldAt(direction: Vec3Node): Vec4Node {
    return this.fieldSampler.sample(direction);
  }

  // 粒の振幅。**1 画素が張る角は画面上の変化率から引く** — 天体の見かけ直径から出すと、
  // 大気圏のすぐ上から見下ろす構図で 1 桁ずれる。解像できない細かさになったら 0 へ落ちるので、
  // 引きの構図では場の分布だけが残る。
  private grainAmplitudeAt(entryDirection: Vec3Node): FloatNode {
    const pixelAngle = max(length(dFdx(entryDirection)), length(dFdy(entryDirection)));
    const wavelengthPixels = max(pixelAngle.mul(this.grainFrequency), 1e-9).reciprocal();
    return smoothstep(GRAIN_FADE_MIN_PIXELS, GRAIN_FADE_FULL_PIXELS, wavelengthPixels);
  }

}
