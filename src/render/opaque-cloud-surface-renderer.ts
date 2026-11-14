// 積雲(雲の場の R = 積雲の量)を、地表の上に立つ不透明な雲頂として描く殻。天体の
// 子として置き、見かけ直径から分割段を選ぶ。雲頂は深度と法線を持つ不透明な面として照らされ、
// 場の texel より細かい起伏は天体固定の細部で足す。
import * as THREE from 'three/webgpu';
import {
  Discard, Fn, If, cameraPosition, cameraProjectionMatrix, dFdx, dFdy, dot, float, length,
  max, modelViewMatrix, modelWorldMatrixInverse, normalize, positionLocal, select,
  sqrt, step, transformNormalToView, uniform, vec3, vec4,
} from 'three/tsl';
import { BlueNoise } from './blue-noise';
import { CloudShapeEvaluator } from './cloud/cloud-shape-evaluator';
import type { CloudSample } from './cloud/cloud-field-sample';
import { CloudFieldSampler } from './cloud/cloud-field-sampler';
import type { CloudRenderInput } from './cloud/cloud-render-input';
import { unitSphereGeometry } from './celestial/celestial-surface';
import { CLOUD_ALBEDO, CLOUD_TOP_SPAN } from './cloud/cumulus-shape';
import { FINEST_DETAIL_WAVELENGTH } from './cloud/cloud-detail';
import { cumulusOpacityNode, cumulusTopAltitudeNode } from './cloud/cloud-kind-node';
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

// 雲頂を探す標本の配り方と、細部の段数。march は殻の中を等間隔にたどる刻みの数(どの交点を
// 見つけるかを決める)、refine は雲頂をまたいだ区間を締める二分の回数(見つけた区間の中の精度を
// 決める)、octaves は細部の段数(粗い側から数える。16〜4 km が粗、1 km までが標準、0.25 km までが精細)。
interface CumulusSampling { readonly march: number; readonly refine: number; readonly octaves: number }

// 段ごとの標本の配り方。費用は march + refine 回の標本化。march 0 は殻を描かない段。
// いちばん粗い段は march を 1 本にして refine で補う — 粗い刻みを 2 本以上にすると、手前と奥で
// 拾った雲頂が 2 枚の層に重なって見える。
const SAMPLING_OF_DETAIL = {
  [CUMULUS_DETAIL.off]: { march: 0, refine: 0, octaves: 0 },
  [CUMULUS_DETAIL.coarse]: { march: 1, refine: 5, octaves: 3 },
  [CUMULUS_DETAIL.standard]: { march: 6, refine: 3, octaves: 5 },
  [CUMULUS_DETAIL.fine]: { march: 12, refine: 3, octaves: 7 },
} as const satisfies Readonly<Record<CumulusDetail, CumulusSampling>>;

// 積雲の精細さの段が使う細部の段数。影も同じ段数で細部を写す。
export function cumulusOctavesOf(detail: CumulusDetail): number {
  return SAMPLING_OF_DETAIL[detail].octaves;
}

// 雲頂の勾配を測る差分の幅 [m]。最も細かいオクターブの半波長に取り、その段の起伏の傾きを
// 法線へ出す。
const NORMAL_STEP = FINEST_DETAIL_WAVELENGTH / 2;

export class OpaqueCloudSurfaceRenderer {
  private readonly shape: CloudShapeEvaluator;
  // 標本の配り方と、その回数まで展開したマテリアル。
  private sampling: CumulusSampling = SAMPLING_OF_DETAIL[CUMULUS_DETAIL.standard];
  private material: THREE.Material;
  private readonly blueNoise = new BlueNoise();
  // 読む雲場。出どころが焼いた写しと cap の置き方を bind で写し取る。
  private readonly fieldSampler = new CloudFieldSampler();
  // 殻を半径 1 とする物体空間での地表の半径。天体ごとの値は uniform で渡す — 定数で焼くと
  // 殻を持つ天体の数だけシェーダが増える。
  private readonly groundRadius: FloatUniform;
  // 天体の基準半径 [m]。画素の張る実寸と細部の波長を結ぶ。
  private readonly bodyRadius: FloatUniform;
  // 雲頂の勾配を測る差分の幅 [rad]。
  private readonly gradientAngle: FloatUniform;
  // 分割段ごとの球。
  private readonly meshes: ReadonlyMap<SphereLodLevel, THREE.Mesh>;
  private activeLevel: SphereLodLevel | null = null;

  // bodyRadius は殻を載せる天体の基準半径 [m]。親は半径 bodyRadius の球へ合わせたスケールを
  // 与えればよく、雲頂ぶんの膨らみはこの renderer が持つ。
  public constructor(bodyRadius: number) {
    // 雲頂を含む殻の尺度と、雲頂の勾配の差分の幅を組む。
    const shellScale = 1 + CLOUD_TOP_SPAN / bodyRadius;
    this.groundRadius = uniform(1 / shellScale);
    this.bodyRadius = uniform(bodyRadius);
    this.shape = new CloudShapeEvaluator(this.bodyRadius);
    this.shape.setDetailOctaves(this.sampling.octaves);
    this.gradientAngle = uniform(NORMAL_STEP / bodyRadius);
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
  public get topAltitude(): number { return CLOUD_TOP_SPAN; }

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

  // 標本の配り方を置き直す。標本の回数はシェーダへ展開されるので、変わればマテリアルを組み直す。
  // 細部の段数は uniform なので、組み直さずに置く。
  private setSampling(sampling: CumulusSampling): void {
    const rebuild = sampling.march !== this.sampling.march || sampling.refine !== this.sampling.refine;
    this.sampling = sampling;
    this.shape.setDetailOctaves(sampling.octaves);
    if (rebuild) this.rebuildMaterial();
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
      const pixelAngle = this.pixelAngleAt(normalize(entry)).toVar();
      const width = pixelAngle.mul(this.bodyRadius).toVar();

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
          entry.add(direction.mul(distance)), pixelAngle, width).lessThan(0);
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
          entry.add(direction.mul(middle)), pixelAngle, width).lessThan(0);
        If(inside, () => { below.assign(middle); }).Else(() => { above.assign(middle); });
      }

      const hitPoint = entry.add(direction.mul(below)).toVar();
      const clip = cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(hitPoint, 1)));
      const viewNormal = normalize(transformNormalToView(this.cloudTopNormalAt(hitPoint, width)));
      Discard(hit.lessThan(0.5));
      return vec4(viewNormal, clip.z.div(clip.w));
    })();
  }

  // 物体空間の点が、その柱の雲頂からどれだけ外に居るか。負なら雲の中。pixelAngle は画素が張る角 [rad]、
  // width はその実寸 [m]。
  private clearanceAt(point: Vec3Node, pixelAngle: FloatNode, width: FloatNode): FloatNode {
    const radius = max(length(point), 1e-6);
    const direction = point.div(radius);
    const cloud = this.fieldAt(direction);
    const detail = this.detailAt(direction, width, cloud.cumulus);
    // 細部は覆いの縁を texel より細かく千切る。**ディザはその柱の方向に貼る** — 視線の入口に貼ると、
    // 雲頂と入口の高さの差ぶんの視差で、視点が動くたびにディザが雲の上を滑る。
    const threshold = this.ditherThreshold(direction, pixelAngle);
    const present = step(threshold, this.shape.opaqueFraction(cumulusOpacityNode(cloud.cumulus), detail));
    // **覆いの無い柱は雲頂を地表へ落とさず、視線を素通しにする** — 落とすと、地表へ達した
    // 刻みが丸めの符号次第で雲頂の内側と判定され、地表いちめんに細部が湧く。
    const clearance = radius.sub(this.shape.cloudTopRadius(
      this.shape.cloudTop(cumulusTopAltitudeNode(cloud.cumulus).div(CLOUD_TOP_SPAN), detail), this.groundRadius));
    return select(present.greaterThan(0.5), clearance, float(1));
  }

  // 交点における雲頂面の法線(物体空間)。**覆いの有無は勾配へ入れない** — 柱ごとに断ち切られた
  // 崖ではなく、雲頂そのものの起伏を法線に出す。
  private cloudTopNormalAt(hitPoint: Vec3Node, width: FloatNode): Vec3Node {
    const up = hitPoint.div(max(length(hitPoint), 1e-6));
    const east = eastAt(up);
    const north = northAt(up);
    // その向きの雲頂(物体空間の半径)。
    const topAt = (direction: Vec3Node): FloatNode => {
      const cloud = this.fieldAt(direction);
      return this.shape.cloudTopRadius(
        this.shape.cloudTop(
          cumulusTopAltitudeNode(cloud.cumulus).div(CLOUD_TOP_SPAN),
          this.detailAt(direction, width, cloud.cumulus),
        ),
        this.groundRadius,
      );
    };
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

  // 画素が張る角 [rad]。**1 画素が張る角は画面上の変化率から引く** — 天体の見かけ直径から出すと、
  // 大気圏のすぐ上から見下ろす構図で 1 桁ずれる。解像できない細かさは細部の段ごとに 0 へ落ちるので、
  // 引きの構図では場の分布だけが残る。
  private pixelAngleAt(entryDirection: Vec3Node): FloatNode {
    return max(length(dFdx(entryDirection)), length(dFdy(entryDirection)));
  }

  // 天体固定の単位方向 direction の細部。width は画素の実寸 [m]、amount はその柱の積雲の量。
  private detailAt(direction: Vec3Node, width: FloatNode, amount: FloatNode): FloatNode {
    return this.shape.detailAt(direction, width, amount, (neighbor) => this.fieldAt(neighbor).cumulus);
  }

  // 覆い尽くされている割合と比べるディザの閾値。**天体に貼った値** — 画面の画素に固定すると、雲が
  // 画面上を動くたびに縁の画素がディザの網目の下を滑ってちらつく。pixelAngle は画素が張る角 [rad]。
  private ditherThreshold(columnDirection: Vec3Node, pixelAngle: FloatNode): FloatNode {
    return this.blueNoise.atSurface(columnDirection, pixelAngle)
      .mul((DITHER_LEVELS - 1) / DITHER_LEVELS).add(0.5 / DITHER_LEVELS);
  }
}
