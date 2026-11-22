// 積雲(雲の場の R = 積雲の量)を、地表の上に立つ不透明な雲頂として描く殻。天体の
// 子として置き、見かけ直径から分割段を選ぶ。雲頂は深度と法線を持つ不透明な面として照らされ、
// 場の texel より細かい起伏は天体固定の細部で足す。
import * as THREE from 'three/webgpu';
import {
  Discard, Fn, If, Loop, and, cameraPosition, cameraProjectionMatrix, dFdx, dFdy, dot, float, length,
  max, mix, modelViewMatrix, modelWorldMatrixInverse, mrt, normalize, positionLocal, select,
  smoothstep, sqrt, step, struct, transformNormalToView, uniform, vec3, vec4,
} from 'three/tsl';
import { BlueNoise } from '../../blue-noise';
import { CloudShapeEvaluator } from './cloud-shape-evaluator';
import type { CloudSample } from './cloud-field-sample';
import { CloudFieldSampler, type CloudFieldBinding } from './cloud-field-sampler';
import type { CloudDetailClockInput } from './cloud-render-input';
import { unitSphereGeometry } from '../../celestial/celestial-surface';
import { CLOUD_ALBEDO, CLOUD_TOP_SPAN } from './cumulus-shape';
import { FINEST_DETAIL_WAVELENGTH } from './cloud-detail';
import {
  cumulusColumnOpticalDepthNode, cumulusFieldTopNode, cumulusOpacityNode,
} from './cloud-kind-node';
import { eastAt, northAt } from '../sphere-frame';
import { markLitCloudShell } from '../../pipeline/lit-layer';
import { markMotionHistoryKey, motionNodeAtPosition } from '../../pipeline/motion-history';
import { sphereLodLevel, SPHERE_LOD_LADDER, type SphereLodLevel } from '../../celestial/screen-lod';
import type { FloatNode, FloatUniform, Vec2Node, Vec3Node, Vec4Node } from '../../tsl-types';

// 雲の粗さ。雲は拡散する面なので、粗さは最大になる。
const CUMULUS_ROUGHNESS = 1;

// ディザの閾値の段数。blue noise は 0..1 の両端を含むので、閾値は半段ぶん内側へ寄せて使う
// — 寄せないと、覆いの無い空へ閾値 0 の画素だけが雲として残り、覆い尽くされた面から閾値 1 の
// 画素の描画欠落が生じる。
const DITHER_LEVELS = 256;

// setSampling で置き直すまでの標本の配り方(刻みの数・二分の回数・細部の段数)。
const INITIAL_SAMPLING: CumulusSampling = { march: 6, refine: 3, octaves: 6 };

// 雲頂を探す標本の配り方と、細部の段数。march は殻の中を等間隔にたどる刻みの数(1 以上。どの交点を
// 見つけるかを決める)、refine は雲頂をまたいだ区間を締める二分の回数(見つけた区間の中の精度を
// 決める)、octaves は細部の段数(32 km の段から数える)。費用は march + refine 回の標本化。
export interface CumulusSampling { readonly march: number; readonly refine: number; readonly octaves: number }

// 1 回のレイマーチが深度・法線・明るさ・動きで共有する結果。normal は view 空間法線に雲の明るさを掛けたもの —
// 明るさは常に正なので、法線の向きと明るさは向きと長さで分けて読める。
const MarchedCloudSurface = struct({ hitPoint: 'vec3', normal: 'vec3', depth: 'float' }, 'MarchedCloudSurface');

// 雲頂の勾配を測る差分の幅 [m]。最も細かいオクターブの半波長に取り、その段の起伏の傾きを
// 法線へ出す。
const NORMAL_STEP = FINEST_DETAIL_WAVELENGTH / 2;

// 柱の光学厚で白さを変える範囲と、薄い柱の明るさの倍率。覆いが飽和する帯の上端(不透明度 0.46)
// で τ≈0.6、深い被覆で τ≈2.4 — その間を薄い灰から白へ写す。覆いがどの柱も 100% に張り付いても、
// 厚みの差が明るさの階調として残る。
const TAU_SHADE_ONSET = 0.5;
const TAU_SHADE_FULL = 2.5;
const THIN_CLOUD_SHADE = 0.75;
// 細部を評価せずに雲の外と決める上界の判定へ持たせる余裕(殻の空間の半径と、覆いの割合の目盛り)。
// 上界と実際の値は別の式で丸まるので、境目の点を雲の外へ倒さないよう数 ulp ぶん内側を残す。
const CEILING_MARGIN = 1e-6;
// 細部の起伏が明るさへ効く深さ。覆いを飽和させるほどは動かさず、板の内部の質感にだけ使う。
const DETAIL_BRIGHTNESS_DEPTH = 0.15;

export class OpaqueCloudSurfaceRenderer {
  private readonly shape: CloudShapeEvaluator;
  // 標本の配り方。刻みと二分の回数は uniform で回すので、置き直してもシェーダを組み直さない。
  private readonly march = uniform(INITIAL_SAMPLING.march, 'int');
  private readonly refine = uniform(INITIAL_SAMPLING.refine, 'int');
  private sampling: CumulusSampling = INITIAL_SAMPLING;
  private readonly material: THREE.Material;
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
    this.shape.setDetailOctaves(INITIAL_SAMPLING.octaves);
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

  // 殻の高度 [m]。場の雲頂高度 0..1 が張る高さでもある。
  public get topAltitude(): number { return CLOUD_TOP_SPAN; }

  // 全段のメッシュを parent の下へ置く。
  public addTo(parent: THREE.Object3D): void {
    for (const mesh of this.meshes.values()) {
      parent.add(mesh);
      // 段を切り替えても動きベクトルの履歴が続くよう、全段で parent の履歴を共有する。
      markMotionHistoryKey(mesh, parent);
    }
  }

  // 標本の配り方を置き直す。次の描画から効く。
  public setSampling(sampling: CumulusSampling): void {
    this.sampling = sampling;
    this.march.value = sampling.march;
    this.refine.value = sampling.refine;
    this.shape.setDetailOctaves(sampling.octaves);
  }

  // いま置いている標本の配り方。
  public get currentSampling(): CumulusSampling { return this.sampling; }

  // 読む雲場と cap の置き方を写し取る。どちらの出どころも同じ cap へ焼くので、グラフは組み直さない。
  public bind(field: CloudFieldBinding): void {
    this.fieldSampler.bind(field);
  }

  // 細部が流れ、生まれ直す時刻を置く。
  public syncClock(clock: CloudDetailClockInput): void {
    this.shape.syncClock(clock.displayTime, clock.simSpeed);
  }

  // 見かけ直径 [px] から分割段を選び、その段のメッシュを見せる。
  public syncLod(apparentDiameterPx: number): void {
    const level = sphereLodLevel(apparentDiameterPx);
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

  // 雲頂の交点を書く不透明な白の標準マテリアル。深度・法線・明るさ・動きは 1 本のレイマーチを共有する。
  private buildMaterial(): THREE.Material {
    const material = new THREE.MeshStandardNodeMaterial({
      roughness: CUMULUS_ROUGHNESS, metalness: 0,
    });
    // 法線の向きと長さ(明るさ)を分けて読み、交点で動きベクトルを書く。
    const marched = this.marchedSurface();
    const shade = marched.get('normal') as Vec3Node;
    material.depthNode = marched.get('depth') as FloatNode;
    material.normalNode = normalize(shade);
    material.colorNode = vec3(CLOUD_ALBEDO).mul(length(shade));
    material.mrtNode = mrt({ motion: motionNodeAtPosition(marched.get('hitPoint') as Vec3Node) });
    return material;
  }

  // 交点の柱の雲の明るさ。雲の白さは柱の光学厚で変わる — 覆いがどの柱も 100% に張り付く空でも、厚みの
  // 差が明るさの差として残る。細部の起伏は薄い明るさへ足して、板の内部の質感にする。値は常に正。
  private brightnessOf(cloud: CloudSample, detail: FloatNode): FloatNode {
    return mix(
      THIN_CLOUD_SHADE, 1,
      smoothstep(TAU_SHADE_ONSET, TAU_SHADE_FULL, cumulusColumnOpticalDepthNode(cloud.cumulus)),
    ).mul(float(1).add(detail.mul(DETAIL_BRIGHTNESS_DEPTH)));
  }

  // 殻の面へ届いた視線を雲頂の高さ場へ下ろし、物体空間の交点・view 空間法線に雲の明るさを掛けたもの・深度を
  // 返す(MarchedCloudSurface)。
  //
  // **画面微分は分岐の外で取り、捨てるのは最後にする** — 粒の振幅が使う dFdx/dFdy は隣接画素との
  // 差なので、条件分岐や discard のあとでは決まらない。
  private marchedSurface(): THREE.Node {
    return Fn(() => {
      const entry = positionLocal.toVar();
      const origin = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;
      const direction = normalize(entry.sub(origin)).toVar();
      const pixelAngle = this.pixelAngleAt(normalize(entry)).toVar();
      const width = pixelAngle.mul(this.bodyRadius).toVar();
      // 細部を運ぶ風は数百キロで均した流れなので、視線が殻を抜ける数キロのあいだは入口で読んだ 1 つで足りる。
      const wind = this.fieldSampler.sampleMotion(normalize(entry)).surfaceWind.toVar();

      // 殻に入ってから地表の球へ達するまで(掠めるなら殻を出るまで)を等分してたどる。
      const along = dot(entry, direction);
      const half = along.mul(along).sub(dot(entry, entry));
      const groundHalf = half.add(this.groundRadius.mul(this.groundRadius));
      const marchEnd = max(select(
        groundHalf.greaterThan(0),
        along.negate().sub(sqrt(max(groundHalf, 0))),
        along.negate().add(sqrt(max(half.add(1), 0))),
      ), 0);
      const stepLength = marchEnd.div(float(this.march)).toVar();

      // 雲頂より内側へ入った最初の刻みを、その手前の刻みと一緒に覚える。命中したあとの
      // 刻みは評価しない — 交点の区間は最初にまたいだ刻みで決まるので、それより先の刻みの
      // 値はどこへも効かない。
      const hit = float(0).toVar();
      const above = float(0).toVar();
      const below = marchEnd.toVar();
      Loop({ start: 1, end: this.march, type: 'int', condition: '<=' }, ({ i }) => {
        const distance = stepLength.mul(float(i)).toVar();
        If(hit.lessThan(0.5), () => {
          const inside = this.clearanceAt(
            entry.add(direction.mul(distance)), pixelAngle, width, wind).lessThan(0);
          If(inside, () => {
            hit.assign(1);
            below.assign(distance);
          }).Else(() => {
            above.assign(distance);
          });
        });
      });
      // 雲頂をまたいだ区間を二分して縁を締める。**外れた視線は締めず法線も引かない** — 捨てる
      // 画素にはどちらの値も届かない。
      const hitPoint = entry.toVar();
      const surface = vec4(0).toVar();
      If(hit.greaterThan(0.5), () => {
        Loop({ start: 0, end: this.refine, type: 'int', condition: '<' }, () => {
          const middle = above.add(below).mul(0.5).toVar();
          const inside = this.clearanceAt(
            entry.add(direction.mul(middle)), pixelAngle, width, wind).lessThan(0);
          If(inside, () => { below.assign(middle); }).Else(() => { above.assign(middle); });
        });
        hitPoint.assign(entry.add(direction.mul(below)));
        const clip = cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(hitPoint, 1)));
        const top = this.cloudTopAt(hitPoint, width, wind).toVar();
        surface.assign(vec4(
          normalize(transformNormalToView(top.xyz)).mul(top.w),
          clip.z.div(clip.w)));
      });
      Discard(hit.lessThan(0.5));
      return MarchedCloudSurface(hitPoint, surface.xyz, surface.w);
    })();
  }

  // 物体空間の点が、その柱の雲頂からどれだけ外に居るか。負なら雲の中。pixelAngle は画素が張る角 [rad]、
  // width はその実寸 [m]、wind は細部を運ぶ風の東・北の成分 [m/s]。
  private clearanceAt(point: Vec3Node, pixelAngle: FloatNode, width: FloatNode, wind: Vec2Node): FloatNode {
    const radius = max(length(point), 1e-6).toVar();
    const direction = point.div(radius).toVar();
    const cloud = this.fieldAt(direction);
    const opacity = cumulusOpacityNode(cloud.cumulus).toVar();
    const fieldTop = cumulusFieldTopNode(cloud.cumulus).toVar();
    // 細部は覆いの縁を texel より細かく千切る。**ディザはその柱の方向に貼る** — 視線の入口に貼ると、
    // 雲頂と入口の高さの差ぶんの視差で、視点が動くたびにディザが雲の上を滑る。
    const threshold = this.ditherThreshold(direction, pixelAngle).toVar();
    // **細部を最大に置いても雲頂へ届かない点と、覆いがディザの閾値へ届かない柱では細部を評価しない** —
    // どちらも雲の外と決まり、細部の値は答えへ効かない。判定は境界の点を雲の外へ倒さない側へ余裕を持たせる。
    const reachable = and(
      radius.lessThan(this.shape.cloudTopRadius(this.shape.cloudTopCeiling(fieldTop), this.groundRadius)
        .add(CEILING_MARGIN)),
      threshold.lessThan(this.shape.opaqueFractionCeiling(opacity).add(CEILING_MARGIN)));
    const clearance = float(1).toVar();
    If(reachable, () => {
      const detail = this.detailAt(direction, width, cloud, wind);
      const present = step(threshold, this.shape.opaqueFraction(opacity, detail));
      // **覆いの無い柱は雲頂を地表へ落とさず、視線を素通しにする** — 落とすと、地表へ達した
      // 刻みが丸めの符号次第で雲頂の内側と判定され、地表いちめんに細部が湧く。
      const surfaceClearance = radius.sub(this.shape.cloudTopRadius(
        this.shape.cloudTop(fieldTop, detail), this.groundRadius));
      clearance.assign(select(present.greaterThan(0.5), surfaceClearance, float(1)));
    });
    return clearance;
  }

  // 交点における雲頂面の法線(物体空間、xyz)と、交点の柱の雲の明るさ(w)。**覆いの有無は勾配へ
  // 入れない** — 柱ごとに断ち切られた崖ではなく、雲頂そのものの起伏を法線に出す。
  private cloudTopAt(hitPoint: Vec3Node, width: FloatNode, wind: Vec2Node): Vec4Node {
    const up = hitPoint.div(max(length(hitPoint), 1e-6));
    const east = eastAt(up);
    const north = northAt(up);
    // 柱の雲標本と細部から、その柱の雲頂(物体空間の半径)。
    const topOf = (cloud: CloudSample, detail: FloatNode): FloatNode => this.shape.cloudTopRadius(
      this.shape.cloudTop(cumulusFieldTopNode(cloud.cumulus), detail), this.groundRadius);
    // その向きの雲頂(物体空間の半径)。
    const topAt = (direction: Vec3Node): FloatNode => {
      const cloud = this.fieldAt(direction);
      return topOf(cloud, this.detailAt(direction, width, cloud, wind));
    };
    // **中心の高さは交点の中心距離ではなく雲頂を引き直して測る** — 締めた交点は雲頂より内側へ
    // 食い込んでいて、中心距離を高さに使うと食い込みが両方向の傾きへ一様なオフセットとして加算される。掠める
    // 視線ほど刻みが長く食い込みも深いので、リム際で法線が倒れて夜側の雲が光る。
    const cloud = this.fieldAt(up);
    const detail = this.detailAt(up, width, cloud, wind).toVar();
    const here = topOf(cloud, detail);
    // 東と北へ粒の半波長ぶん振った雲頂との差が、そのまま接平面での傾き。
    const slopeEast = topAt(normalize(up.add(east.mul(this.gradientAngle))))
      .sub(here).div(this.gradientAngle);
    const slopeNorth = topAt(normalize(up.add(north.mul(this.gradientAngle))))
      .sub(here).div(this.gradientAngle);
    return vec4(
      normalize(up.sub(east.mul(slopeEast)).sub(north.mul(slopeNorth))), this.brightnessOf(cloud, detail));
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

  // 天体固定の単位方向 direction の細部。width は画素の実寸 [m]、cloud はその柱の雲標本、wind は細部を
  // 運ぶ風の東・北の成分 [m/s]。
  private detailAt(direction: Vec3Node, width: FloatNode, cloud: CloudSample, wind: Vec2Node): FloatNode {
    return this.shape.detailAt(
      direction, width, cloud.cumulus, (neighbor) => this.fieldAt(neighbor).cumulus, wind,
      this.shape.grainOf(cloud), cloud.cumulusCell);
  }

  // 覆い尽くされている割合と比べるディザの閾値。**天体に貼った値** — 画面の画素に固定すると、雲が
  // 画面上を動くたびに縁の画素がディザの網目の下を滑ってちらつく。pixelAngle は画素が張る角 [rad]。
  private ditherThreshold(columnDirection: Vec3Node, pixelAngle: FloatNode): FloatNode {
    return this.blueNoise.atSurface(columnDirection, pixelAngle)
      .mul((DITHER_LEVELS - 1) / DITHER_LEVELS).add(0.5 / DITHER_LEVELS);
  }
}
