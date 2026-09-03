// 積雲(雲の場の R = 被覆率、G = 雲頂高度)を、地表の上に立つ不透明な雲として描くメッシュ。
// 分割段ラダーの各段ぶんの球を1枚のマテリアルで束ね、見かけ直径に応じて1段だけを見せる。殻の面へ
// 届いた視線は雲頂の高さ場まで下ろして交点を探し、そこの深度と法線を書く。場の texel より細かい
// 粒は天体固定のノイズで足す。陰影・遮蔽・逆二乗の減衰はすべてパイプラインが与える。
import * as THREE from 'three/webgpu';
import {
  Discard, Fn, If, cameraPosition, cameraProjectionMatrix, dFdx, dFdy, dot, float, length,
  max, modelViewMatrix, modelWorldMatrixInverse, normalize, positionLocal, select, smoothstep,
  sqrt, step, texture as textureNode, transformNormalToView, vec3, vec4,
} from 'three/tsl';
import { BlueNoise } from './blue-noise';
import { DeferredTexture } from './deferred-texture';
import { sphereMeshUv, unitSphereGeometry } from './celestial-surface';
import {
  CLOUD_TOP_SPAN, CUMULUS_GRAIN_SIZE, cloudTopOf, grainAt, opaqueFractionOf,
} from './cloud/cumulus-shape';
import { eastAt, northAt } from './cloud/sphere-frame';
import { markLitOpaque } from './pipeline/lit-layer';
import { sphereLodLevel, SPHERE_LOD_LADDER, SphereLodLevel } from './screen-lod';
import type { FloatNode, Vec3Node, Vec4Node } from './tsl-types';

// 不透明な積雲のアルベド。厚い雲の白さは多重散乱の産物で、単散乱アルベド ≈ 1・光学的厚みが
// 十分に大きい層の反射は拡散反射の極限へ漸近する。
const CUMULUS_ALBEDO = 0.8;
// 雲の粗さ。雲は拡散する面なので、粗さは最大になる。
const CUMULUS_ROUGHNESS = 1;

// ディザの閾値の段数。blue noise は 0..1 の両端を含むので、閾値は半段ぶん内側へ寄せて使う
// — 寄せないと、覆いの無い空へ閾値 0 の画素だけが雲として残り、覆い尽くされた面から閾値 1 の
// 画素が抜ける。
const DITHER_LEVELS = 256;

// 積雲の精細さの段。オフは殻を描かない段。**値は保存された設定を読む鍵なので、段を足すときも
// 既存の値を動かさない** — 番号を詰め直すと、保存済みの設定が黙って別の段を指す。
export const CUMULUS_DETAIL = { off: 0, coarse: 1, standard: 2, fine: 3 } as const;
export type CumulusDetail = (typeof CUMULUS_DETAIL)[keyof typeof CUMULUS_DETAIL];

// 雲頂を探す標本の配り方。march は殻の中を等間隔にたどる刻みの数(どの交点を見つけるかを決める)、
// refine は雲頂をまたいだ区間を締める二分の回数(見つけた区間の中の精度を決める)。
type CumulusSampling = { readonly march: number; readonly refine: number };

// 段ごとの標本の配り方。**費用は march + refine 回の標本化**、深さの分解能は march と 2^refine の
// 積で決まる。march 0 は「どの視線も雲頂と交わらない」に落ちる。
//
// **いちばん粗い段の march は 1 本に留める** — 2 本以上あると、手前の刻みで拾った雲頂と奥の
// 刻みで拾った雲頂が 2 枚の層として重なって読める。1 本なら殻の内側に層は立たず、雲頂の高さ
// だけを持つ一枚の不透明な面になる。**そのぶん二分の回数はここだけ増やす** — 締める前の区間が
// 殻の端から端まで広がるので、他の段と同じ回数では雲頂が深さの段へ割れて縞に見える。
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

export class CumulusShell {
  private readonly fieldMap: DeferredTexture;
  // 標本の配り方と、その回数まで展開したマテリアル。配り方は表示側が毎フレーム押し込む。
  private sampling: CumulusSampling = SAMPLING_OF_DETAIL[CUMULUS_DETAIL.standard];
  private material: THREE.Material;
  private readonly blueNoise = new BlueNoise();
  // 殻を半径 1 とする物体空間での地表の半径。レイマーチの下端になる。
  private readonly groundRadius: number;
  // 粒の 1 rad あたりの山の数と、雲頂の勾配を測る差分の幅 [rad]。差分は粒の半波長ぶんなので、
  // 場の起伏と粒の起伏が同じ 1 つの法線に出る。
  private readonly grainFrequency: number;
  private readonly gradientAngle: number;
  // 段ごとの球。表示側が親の位置・スケール・自転姿勢を毎フレーム与える。
  private readonly meshes: ReadonlyMap<SphereLodLevel, THREE.Mesh>;
  private activeLevel: SphereLodLevel | null = null;

  // fieldUrl は雲の場、bodyRadius は殻を載せる天体の基準半径 [m]。親は半径 bodyRadius の球へ
  // 合わせたスケールを与えればよく、雲頂ぶんの膨らみはこの殻が持つ。
  public constructor(fieldUrl: string, bodyRadius: number) {
    this.fieldMap = new DeferredTexture(fieldUrl, THREE.NoColorSpace);
    // 正距円筒の経度は周期的なので、場は経度方向へ巻く。
    this.fieldMap.texture.wrapS = THREE.RepeatWrapping;
    const shellScale = 1 + CLOUD_TOP_SPAN / bodyRadius;
    this.groundRadius = 1 / shellScale;
    this.grainFrequency = bodyRadius / CUMULUS_GRAIN_SIZE;
    this.gradientAngle = 0.5 / this.grainFrequency;
    this.material = this.buildMaterial();

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

  // 雲の場のテクスチャ。解放までこの殻が持つ。
  public get field(): THREE.Texture { return this.fieldMap.texture; }

  // 殻の高度 [m]。場の雲頂高度 0..1 が張る高さでもある。
  public get topAltitude(): number { return CLOUD_TOP_SPAN; }

  // 全段のメッシュを parent の下へ置き、場の画像の取得を始める。
  public addTo(parent: THREE.Object3D): void {
    this.fieldMap.request();
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

  // 全段のメッシュを親から外し、マテリアル・場・ディザのタイルを解放する。
  public dispose(): void {
    for (const mesh of this.meshes.values()) mesh.removeFromParent();
    this.material.dispose();
    this.fieldMap.dispose();
    this.blueNoise.dispose();
  }

  // 雲頂の交点を書く不透明な白の標準マテリアル。深度と法線は 1 本のレイマーチを共有する。
  private buildMaterial(): THREE.Material {
    const material = new THREE.MeshStandardNodeMaterial({
      roughness: CUMULUS_ROUGHNESS, metalness: 0,
    });
    const marched = this.marchedSurface().toVar();
    material.depthNode = marched.w;
    material.normalNode = marched.xyz;
    material.colorNode = vec3(CUMULUS_ALBEDO);
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
      const threshold = this.ditherThreshold().toVar();
      const grainAmplitude = this.grainAmplitudeAt(normalize(entry)).toVar();

      // 殻に入ってから地表の球へ達するまで(掠めるなら殻を出るまで)を等分してたどる。
      const along = dot(entry, direction);
      const half = along.mul(along).sub(dot(entry, entry));
      const groundHalf = half.add(this.groundRadius * this.groundRadius);
      const marchEnd = max(select(
        groundHalf.greaterThan(0),
        along.negate().sub(sqrt(max(groundHalf, 0))),
        along.negate().add(sqrt(max(half.add(1), 0))),
      ), 0);
      const sampling = this.sampling;
      const stepLength = marchEnd.div(sampling.march);

      // 雲頂より内側へ入った最初の刻みを、その手前の刻みと一緒に覚える。
      const hit = float(0).toVar();
      const above = float(0).toVar();
      const below = marchEnd.toVar();
      for (let stepIndex = 1; stepIndex <= sampling.march; stepIndex++) {
        const distance = stepLength.mul(stepIndex);
        const inside = this.clearanceAt(
          entry.add(direction.mul(distance)), threshold, grainAmplitude).lessThan(0);
        If(inside.and(hit.lessThan(0.5)), () => {
          hit.assign(1);
          below.assign(distance);
        });
        If(hit.lessThan(0.5), () => { above.assign(distance); });
      }
      // 雲頂をまたいだ区間を二分して縁を締める。
      for (let refineIndex = 0; refineIndex < sampling.refine; refineIndex++) {
        const middle = above.add(below).mul(0.5);
        const inside = this.clearanceAt(
          entry.add(direction.mul(middle)), threshold, grainAmplitude).lessThan(0);
        If(inside, () => { below.assign(middle); }).Else(() => { above.assign(middle); });
      }

      const hitPoint = entry.add(direction.mul(below)).toVar();
      const clip = cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(hitPoint, 1)));
      const viewNormal = normalize(transformNormalToView(this.cloudTopNormalAt(hitPoint, grainAmplitude)));
      Discard(hit.lessThan(0.5));
      return vec4(viewNormal, clip.z.div(clip.w));
    })();
  }

  // 物体空間の点が、その柱の雲頂からどれだけ外に居るか。負なら雲の中。
  private clearanceAt(point: Vec3Node, threshold: FloatNode, grainAmplitude: FloatNode): FloatNode {
    const radius = max(length(point), 1e-6);
    const direction = point.div(radius);
    const cloud = this.fieldAt(direction);
    const grain = grainAt(direction, this.grainFrequency, grainAmplitude);
    // 粒は覆いの縁を texel より細かく千切る。**引けなかった粒は均さない** — ディザが縁の内外へ
    // 振り分けるので、均すと雲そのものが砂に散る。
    const present = step(threshold, opaqueFractionOf(cloud.r, grain, float(0)));
    // **覆いの無い柱は雲頂を地表へ落とさず、視線を素通しにする** — 落とすと、地表へ達した
    // 刻みが丸めの符号次第で雲頂の内側と判定され、地表いちめんに粒が湧く。
    const clearance = radius.sub(this.cloudTopRadiusOf(cloudTopOf(cloud.g, grain)));
    return select(present.greaterThan(0.5), clearance, float(1));
  }

  // 交点における雲頂面の法線(物体空間)。**覆いの有無は勾配へ入れない** — 柱ごとに断ち切られた
  // 崖ではなく、雲頂そのものの起伏を法線に出す。
  private cloudTopNormalAt(hitPoint: Vec3Node, grainAmplitude: FloatNode): Vec3Node {
    const up = hitPoint.div(max(length(hitPoint), 1e-6));
    const east = eastAt(up);
    const north = northAt(up);
    // その向きの雲頂(物体空間の半径)。
    const topAt = (direction: Vec3Node): FloatNode => this.cloudTopRadiusOf(
      cloudTopOf(this.fieldAt(direction).g, grainAt(direction, this.grainFrequency, grainAmplitude)));
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

  // 雲頂高度 0..1 を、殻を半径 1 とする物体空間の半径へ直す。
  private cloudTopRadiusOf(cloudTop: FloatNode): FloatNode {
    return cloudTop.mul(1 - this.groundRadius).add(this.groundRadius);
  }

  // 天体固定の単位方向における場の値。
  private fieldAt(direction: Vec3Node): Vec4Node {
    return textureNode(this.fieldMap.texture, sphereMeshUv(direction));
  }

  // 粒の振幅。**1 画素が張る角は画面上の変化率から引く** — 天体の見かけ直径から出すと、
  // 大気圏のすぐ上から見下ろす構図で 1 桁ずれる。解像できない細かさになったら 0 へ落ちるので、
  // 引きの構図では場の分布だけが残る。
  private grainAmplitudeAt(entryDirection: Vec3Node): FloatNode {
    const pixelAngle = max(length(dFdx(entryDirection)), length(dFdy(entryDirection)));
    const wavelengthPixels = max(pixelAngle.mul(this.grainFrequency), 1e-9).reciprocal();
    return smoothstep(GRAIN_FADE_MIN_PIXELS, GRAIN_FADE_FULL_PIXELS, wavelengthPixels);
  }

  // 画素ごとに固定の、覆い尽くされている割合と比べるディザの閾値。
  private ditherThreshold(): FloatNode {
    return this.blueNoise.atScreenPixel()
      .mul((DITHER_LEVELS - 1) / DITHER_LEVELS).add(0.5 / DITHER_LEVELS);
  }
}
