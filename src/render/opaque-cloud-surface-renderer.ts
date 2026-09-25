// 積雲(雲の場の R = 被覆率、G = 雲頂高度)を、地表の上に立つ不透明な雲頂として描く殻。天体の
// 子として置き、見かけ直径から分割段を選ぶ。雲頂は深度と法線を持つ不透明な面として照らされ、
// 場の texel より細かい起伏は天体固定の粒で足す。
import * as THREE from 'three/webgpu';
import {
  Discard, Fn, If, cameraPosition, cameraProjectionMatrix, dFdx, dFdy, dot, float, length,
  max, modelViewMatrix, modelWorldMatrixInverse, normalize, positionLocal, select,
  sqrt, transformNormalToView, uniform, vec3, vec4,
} from 'three/tsl';
import { BlueNoise } from './blue-noise';
import {
  CLOUD_DENSITY_TOP_M,
  CloudDensityEvaluator,
} from './cloud/cloud-density-evaluator';
import { CLOUD_DETAIL_SCALE_M } from './cloud/cloud-detail-field';
import type { CloudSample } from './cloud/cloud-field-sample';
import { CloudFieldSampler } from './cloud/cloud-field-sampler';
import type { CloudRenderInput } from './cloud/cloud-render-input';
import { unitSphereGeometry } from './celestial/celestial-surface';
import { CLOUD_ALBEDO } from './cloud/cumulus-shape';
import { eastAt, northAt } from './cloud/sphere-frame';
import { markLitCloudShell } from './pipeline/lit-layer';
import { sphereLodLevel, SPHERE_LOD_LADDER, type SphereLodLevel } from './celestial/screen-lod';
import type { FloatNode, FloatUniform, Vec3Node, Vec4Node } from './tsl-types';

// 雲の粗さ。雲は拡散する面なので、粗さは最大になる。
const CUMULUS_ROUGHNESS = 1;

// ディザの閾値の段数。blue noise は 0..1 の両端を含むので、閾値は半段ぶん内側へ寄せて使う
// — 寄せないと、覆いの無い空へ閾値 0 の画素だけが雲として残り、覆い尽くされた面から閾値 1 の
// 画素の描画欠落が生じる。
const DITHER_LEVELS = 256;

// 積雲の精細さの段。オフは殻を描かない段。**値は保存された設定を読む鍵なので、段を足すときも
// 既存の値を動かさない** — 番号を詰め直すと、保存済みの設定が黙って別の段を指す。
export const CUMULUS_DETAIL = { off: 0, coarse: 1, standard: 2, fine: 3 } as const;
export type CumulusDetail = (typeof CUMULUS_DETAIL)[keyof typeof CUMULUS_DETAIL];

// 雲頂を探す標本の配り方。march は殻の中を等間隔にたどる刻みの数(どの交点を見つけるかを決める)、
// refine は雲頂をまたいだ区間を締める二分の回数(見つけた区間の中の精度を決める)。
interface CumulusSampling { readonly march: number; readonly refine: number }

// 段ごとの標本の配り方。費用は march + refine 回の標本化。march 0 は殻を描かない段。
// いちばん粗い段は march を 1 本にして refine で補う — 粗い刻みを 2 本以上にすると、手前と奥で
// 拾った雲頂が 2 枚の層に重なって見える。
const SAMPLING_OF_DETAIL = {
  [CUMULUS_DETAIL.off]: { march: 0, refine: 0 },
  [CUMULUS_DETAIL.coarse]: { march: 1, refine: 5 },
  [CUMULUS_DETAIL.standard]: { march: 6, refine: 3 },
  [CUMULUS_DETAIL.fine]: { march: 12, refine: 3 },
} as const satisfies Readonly<Record<CumulusDetail, CumulusSampling>>;

export class OpaqueCloudSurfaceRenderer {
  private readonly density: CloudDensityEvaluator;
  // 標本の配り方と、その回数まで展開したマテリアル。
  private sampling: CumulusSampling = SAMPLING_OF_DETAIL[CUMULUS_DETAIL.standard];
  private material: THREE.Material;
  private readonly blueNoise = new BlueNoise();
  // 読む雲場。出どころが焼いた写しと cap の置き方を bind で写し取る。
  private readonly fieldSampler = new CloudFieldSampler();
  // 殻を半径 1 とする物体空間での地表の半径と、実寸へ戻す基準半径。
  private readonly groundRadius: FloatUniform;
  private readonly surfaceRadiusM: FloatUniform;
  // 2 km detail の半波長ぶん方向を振って雲頂法線を測る角度[rad]。
  private readonly gradientAngle: FloatUniform;
  // 分割段ごとの球。
  private readonly meshes: ReadonlyMap<SphereLodLevel, THREE.Mesh>;
  private activeLevel: SphereLodLevel | null = null;

  // bodyRadius は殻を載せる天体の基準半径 [m]。親は半径 bodyRadius の球へ合わせたスケールを
  // 与えればよく、雲頂ぶんの膨らみはこの renderer が持つ。
  public constructor(bodyRadius: number) {
    // 共通3D密度の上端までを殻に収める。detailは実寸2 km基準なので天体半径から角度へ変換する。
    const shellScale = 1 + CLOUD_DENSITY_TOP_M / bodyRadius;
    this.groundRadius = uniform(1 / shellScale);
    this.surfaceRadiusM = uniform(bodyRadius);
    this.density = new CloudDensityEvaluator(this.surfaceRadiusM);
    this.gradientAngle = uniform(0.5 * CLOUD_DETAIL_SCALE_M / bodyRadius);
    this.material = this.buildMaterial();

    // 詳細度ごとのメッシュを同じ雲場へ束ねる。
    const meshes = new Map<SphereLodLevel, THREE.Mesh>();
    for (const level of SPHERE_LOD_LADDER) {
      const mesh = new THREE.Mesh(unitSphereGeometry(level), this.material);
      mesh.scale.setScalar(shellScale);
      mesh.visible = false;
      markLitCloudShell(mesh);
      meshes.set(level, mesh);
    }
    this.meshes = meshes;
  }

  // 殻を描いている段があるか。
  public get visible(): boolean { return this.activeLevel !== null; }

  // 殻の高度 [m]。場の雲頂高度 0..1 が張る高さでもある。
  public get topAltitude(): number { return CLOUD_DENSITY_TOP_M; }

  // 全段のメッシュを parent の下へ置く。
  public addTo(parent: THREE.Object3D): void {
    for (const mesh of this.meshes.values()) parent.add(mesh);
  }

  // 積雲の精細さの段を置き直す。オフなら全段を隠す。
  public setDetail(detail: CumulusDetail): void {
    this.setSampling(SAMPLING_OF_DETAIL[detail]);
    if (detail === CUMULUS_DETAIL.off) this.hide();
  }

  // 読む雲場と cap の置き方を写し取る。どちらの出どころも同じ cap へ焼くので、グラフは組み直さない。
  public bind(input: CloudRenderInput): void {
    this.fieldSampler.bind(input.field);
  }

  // 標本の配り方を置き直す。回数はシェーダへ展開されるので、変わればマテリアルを組み直す。
  private setSampling(sampling: CumulusSampling): void {
    if (sampling.march === this.sampling.march && sampling.refine === this.sampling.refine) return;
    this.sampling = sampling;
    this.rebuildMaterial();
  }

  // いまの標本の配り方と雲場でマテリアルを組み直し、全段のメッシュへ張り替える。
  private rebuildMaterial(): void {
    const previous = this.material;
    this.material = this.buildMaterial();
    for (const mesh of this.meshes.values()) mesh.material = this.material;
    previous.dispose();
  }

  // 見かけ直径 [px] から分割段を選び、その段のメッシュを見せる。精細さがオフなら全段を隠す。
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

  // 全段のメッシュを親から外し、マテリアルを解放する。雲場のテクスチャは出どころが解放する。
  public dispose(): void {
    this.hide();
    for (const mesh of this.meshes.values()) mesh.removeFromParent();
    this.material.dispose();
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
    material.colorNode = vec3(CLOUD_ALBEDO);
    return material;
  }

  // 殻の面へ届いた視線を雲頂の高さ場へ下ろし、交点の view 空間法線(xyz)と深度(w)を返す。
  //
  // **画面微分は分岐の外で取り、捨てるのは最後にする** — 粒の振幅が使う dFdx/dFdy は隣接画素との
  // 差なので、条件分岐や discard のあとでは決まらない。
  private marchedSurface(): Vec4Node {
    return Fn(() => {
      const entry = positionLocal.toVar();
      const origin = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;
      const direction = normalize(entry.sub(origin)).toVar();
      const threshold = this.ditherThreshold().toVar();
      const footprintM = this.footprintAt(normalize(entry)).toVar();

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

      // 雲頂より内側へ入った最初の刻みを、その手前の刻みと一緒に覚える。
      const hit = float(0).toVar();
      const above = float(0).toVar();
      const below = marchEnd.toVar();
      for (let stepIndex = 1; stepIndex <= sampling.march; stepIndex++) {
        const distance = stepLength.mul(stepIndex);
        const inside = this.clearanceAt(
          entry.add(direction.mul(distance)), threshold, footprintM).lessThan(0);
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
          entry.add(direction.mul(middle)), threshold, footprintM).lessThan(0);
        If(inside, () => { below.assign(middle); }).Else(() => { above.assign(middle); });
      }

      const hitPoint = entry.add(direction.mul(below)).toVar();
      const clip = cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(hitPoint, 1)));
      const viewNormal = normalize(transformNormalToView(this.cloudTopNormalAt(hitPoint, footprintM)));
      Discard(hit.lessThan(0.5));
      return vec4(viewNormal, clip.z.div(clip.w));
    })();
  }

  // 共通3D密度の液相体積率とディザ閾値の差。負なら不透明核の内側。
  private clearanceAt(point: Vec3Node, threshold: FloatNode, footprintM: FloatNode): FloatNode {
    const radius = max(length(point), 1e-6);
    const direction = point.div(radius);
    const altitudeM = max(
      radius.sub(this.groundRadius)
        .div(max(float(1).sub(this.groundRadius), 1e-6))
        .mul(CLOUD_DENSITY_TOP_M),
      0,
    );
    const cloud = this.fieldAt(direction);
    return threshold.sub(
      this.density.sample(cloud, direction, altitudeM, footprintM).liquidFraction,
    );
  }

  // 交点における雲頂面の法線(物体空間)。**覆いの有無は勾配へ入れない** — 柱ごとに断ち切られた
  // 崖ではなく、雲頂そのものの起伏を法線に出す。
  private cloudTopNormalAt(hitPoint: Vec3Node, footprintM: FloatNode): Vec3Node {
    const up = hitPoint.div(max(length(hitPoint), 1e-6));
    const east = eastAt(up);
    const north = northAt(up);
    // その向きの共有密度場の液相雲頂を、物体空間の殻半径へ戻す。
    const topAt = (direction: Vec3Node): FloatNode => this.groundRadius.add(
      this.density.liquidTopM(this.fieldAt(direction), direction, footprintM)
        .div(CLOUD_DENSITY_TOP_M)
        .mul(float(1).sub(this.groundRadius)),
    );
    // **中心の高さは交点の中心距離ではなく雲頂を引き直して測る** — 締めた交点は雲頂より内側へ
    // 食い込んでいて、中心距離を高さに使うと食い込みが両方向の傾きへ一様なオフセットとして加算される。掠める
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
  private fieldAt(direction: Vec3Node): CloudSample {
    return this.fieldSampler.sampleCloud(direction);
  }

  // 画面1pxが地表付近で張る実寸[m]。共通detail evaluatorがこの幅から2 km成分を帯域制限する。
  private footprintAt(entryDirection: Vec3Node): FloatNode {
    const pixelAngle = max(length(dFdx(entryDirection)), length(dFdy(entryDirection)));
    return pixelAngle.mul(this.surfaceRadiusM);
  }

  // 画素ごとに固定の、覆い尽くされている割合と比べるディザの閾値。
  private ditherThreshold(): FloatNode {
    return this.blueNoise.atScreenPixel()
      .mul((DITHER_LEVELS - 1) / DITHER_LEVELS).add(0.5 / DITHER_LEVELS);
  }
}
