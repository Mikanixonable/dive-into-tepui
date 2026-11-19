// 積雲の柱と巻雲の層が落とす影。描画座標の点へ恒星の直射光がどれだけ届くかを、雲の層を抜ける光路の
// 消散の TSL グラフとして返す。影を落とす殻 1 体ぶんを毎フレーム set() で受ける。
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, abs, and, ceil, clamp, dot, float, greaterThan, int, length, max, min,
  normalize, select, sqrt, uniform, vec4,
} from 'three/tsl';
import { CIRRUS_PRESENT_AMOUNT, CirrusDetailEvaluator, cirrusColumnInputOf } from '../../earth-weather/cloud/cloud-detail';
import { CloudFieldSampler } from '../../earth-weather/cloud/cloud-field-sampler';
import type { CloudRenderInput } from '../../earth-weather/cloud/cloud-render-input';
import type { CloudSample } from '../../earth-weather/cloud/cloud-field-sample';
import { CloudShapeEvaluator } from '../../earth-weather/cloud/cloud-shape-evaluator';
import {
  cirrusColumnOpticalDepthNode, cirrusTopAltitudeNode, cumulusFieldTopNode,
  cumulusInCloudOpticalDepthNode, cumulusOpacityNode,
} from '../../earth-weather/cloud/cloud-kind-node';
import { ICE_CLOUD_ASYMMETRY, LIQUID_CLOUD_ASYMMETRY } from '../../earth-weather/cloud/cloud-optics';
import { cloudReflectanceNode, fractionalTransmittanceNode } from '../../earth-weather/cloud/cloud-optics-node';
import type { FloatNode, FloatUniform, Mat4Uniform, Vec3Node, Vec3Uniform } from '../../tsl-types';
import type { SunLight } from '../sun-light';
import type { CloudShadowKinds } from './shadow-select';

// 影を落とす雲を持つ天体 1 体ぶん。center は描画座標の天体中心、surfaceRadius は雲の高度の基準
// 半径 [m]、axes は天体固定の半軸 [m]、bodyFromWorld は描画座標のベクトルを天体固定の向きへ
// 回す行列、cloud は焼いた雲場と、それを焼いた cap の置き方・雲頂高度の組。
export interface ShadowCloud {
  readonly center: THREE.Vector3;
  readonly surfaceRadius: number;
  readonly axes: THREE.Vector3;
  readonly bodyFromWorld: THREE.Matrix4;
  readonly cloud: CloudRenderInput;
}

// 光路のタップ数。巻雲はその場の雲頂高度の薄い層を全光路で横切るので、層の厚みを分ける程度の
// 本数で足りる。
const SHADOW_TAPS = 6;
// 積雲の届く高さと位置を拾う前走の間隔 [m] と本数の幅。**間隔は柱の幅より細かく** —
// 光路を均した本数でたどると、低い恒星で光路が数百 km へ伸びたときに幅数 km の柱が間へ落ちて
// 拾えず、斜めに落ちる影が抜ける。本数は光路の長さに比例させ、上限を持つ。
const COARSE_STEP = 3e3;
const COARSE_TAPS_MIN = 10;
const COARSE_TAPS_MAX = 64;
// 細部を評価する積雲のタップの間隔 [m] と上限。前走で拾った区間へこの間隔で配り、区間が
// 長いときは本数の上限で間隔を緩める。
const FINE_STEP = 1.5e3;
const FINE_TAPS_MAX = 24;
// この量を下回る積雲の柱は、細部を最大に乗せても不透明度のディザの帯の下端へ届かない。
// 影への寄与は 0 なので、前走では「積雲がある」と数えない。
const CUMULUS_PRESENT_AMOUNT = 0.003;
// 大気のサンプル点向けの粗い推定をたどるタップ数。柱の形は解かず、影の濃さの分布だけ拾う。
const AMBIENT_TAPS = 4;
// 光路をたどる長さの上限 [m]。恒星が地平線へ寄るほど層を抜けるまでの距離は伸び、昼夜境界の
// 真上で発散する。
const MAX_LIGHT_PATH = 3e5;
// 光路 1 歩が代表する幅を、場のぼかしへ何倍で写すか。**等倍では足りない** — 隣り合うタップの
// 覆う範囲が接するだけなので、あいだに影の抜けた縞が残る。
const STEP_BLUR = 2;
// 巻雲の層を斜めに抜ける光路の伸びへ張る上限。恒星が地平線へ寄ると 1/cos は発散するので、
// 層の厚みぶんの弦を通る程度で頭打ちにする。
const CIRRUS_MAX_SLANT = 20;

export class CloudShadowRenderer {
  private readonly center: Vec3Uniform;
  private readonly surfaceRadius: FloatUniform;
  private readonly axes: Vec3Uniform;
  private readonly topAltitude: FloatUniform;
  private readonly bodyFromWorld: Mat4Uniform;
  // 種類ごとの影の有無。影の項ごとに掛けるので分けて持つ。
  private readonly cumulusActive: FloatUniform;
  private readonly cirrusActive: FloatUniform;
  // 雲場の読み取りと形状式は共有入力層へ置く。ここは太陽光路の透過率だけを所有する。
  private readonly fieldSampler = new CloudFieldSampler();
  private readonly shape: CloudShapeEvaluator;
  // 巻雲の筋の細部。
  private readonly cirrusDetail = new CirrusDetailEvaluator();

  // 殻 1 体ぶんの uniform を確保する。殻の有無と種類ごとの有無は uniform で切るので、
  // グラフの形は変わらない。
  public constructor(private readonly sunLight: SunLight) {
    this.center = uniform(new THREE.Vector3());
    this.surfaceRadius = uniform(0);
    // 場を持たないフレームでも殻の空間への写しは走るので、半軸は 0 で割らない値から始める。
    this.axes = uniform(new THREE.Vector3(1, 1, 1));
    this.topAltitude = uniform(0);
    this.bodyFromWorld = uniform(new THREE.Matrix4());
    this.cumulusActive = uniform(0);
    this.cirrusActive = uniform(0);
    this.shape = new CloudShapeEvaluator(this.surfaceRadius);
  }

  // このフレームに影を落とす天体と、雲の種類ごとの有無。cloud が null なら雲の影は落ちない。
  public set(cloud: ShadowCloud | null, kinds: CloudShadowKinds): void {
    // 細部の段数は表面の雲と同じ値を置く。段数は uniform なので、グラフは組み直さない。
    this.shape.setDetailOctaves(kinds.cumulusOctaves);
    this.cirrusDetail.setOctaves(kinds.cirrusOctaves);
    this.cumulusActive.value = cloud !== null && kinds.cumulus ? 1 : 0;
    this.cirrusActive.value = cloud !== null && kinds.cirrus ? 1 : 0;
    if (cloud === null || (!kinds.cumulus && !kinds.cirrus)) {
      this.fieldSampler.unbind();
      return;
    }
    this.center.value.copy(cloud.center);
    this.surfaceRadius.value = cloud.surfaceRadius;
    this.axes.value.copy(cloud.axes);
    this.topAltitude.value = cloud.cloud.topAltitude;
    this.bodyFromWorld.value.copy(cloud.bodyFromWorld);
    this.fieldSampler.bind(cloud.cloud.field);
    this.shape.syncClock(cloud.cloud.clock.displayTime, cloud.cloud.clock.simSpeed);
    this.cirrusDetail.syncClock(cloud.cloud.clock.displayTime, cloud.cloud.clock.simSpeed);
  }

  // このフレームに雲の影があるか。どちらかの種類が落ちれば真。
  public casts(): boolean { return this.cumulusActive.value > 0 || this.cirrusActive.value > 0; }

  // 受け手から恒星へ向かう光路を、雲の層(地表から殻の上端まで)を抜けるまで殻の空間
  // (toShellSpace)でたどり、通る割合ぶん雲が返す光を積む。届く光は、積雲では覆っていない
  // 割合 + 覆っている割合 × (1 − R(τ_in))、巻雲では 1 − R(τ)。
  //
  // 覆いの形も柱の中の厚みも殻が雲を立てるのと同じ規則(cloud/cumulus-shape.ts)から引くので、
  // 影は殻のシルエットの下へ落ちる。返す光の割合は光路長ではなく稼いだ高度で配分するので、
  // 柱を 1 本抜ける合計はどれだけ斜めでも覆う割合 × R に一致する。
  // 受け手が自分の柱の雲頂の高さにいるときは、その柱で自分を陰らせない(receiverFloorAltitude)。
  // footprint は受け手の位置で画面 1 px が張る実寸 [m] で、細部の段を決める。
  public transmittance(worldPos: Vec3Node, footprint: FloatNode): FloatNode {
    const sunDir = this.sunLight.directionFrom(worldPos);
    return Fn(() => {
      const transmittance = float(1).toVar();
      // どちらの種類の影も無いフレームで、タップぶんのフェッチを丸ごと飛ばす。
      If(greaterThan(max(this.cumulusActive, this.cirrusActive), 0.5), () => {
        const bodyRadius = max(this.surfaceRadius, 1);
        const offset = this.toShellSpace(worldPos.sub(this.center));
        // **光路の向きも殻の空間で取り直す** — 半軸で割ると向きが傾くので、描画座標の恒星方向を
        // そのまま使うと、光路が層を斜めに横切る量が緯度ぶんずれる。
        const rayDir = normalize(this.toShellSpace(sunDir));
        // 殻の上端の半径。地表が 1 なので、高さは基準半径で割った目盛りで乗る。
        const shellRadius = float(1).add(this.topAltitude.div(bodyRadius));
        const along = dot(offset, rayDir);
        // 光路が殻を出るまでの距離。殻より上の受け手では負になり、影は落ちない。長さは殻の空間の
        // 半径 1 を基準半径として測る(真の実寸との差は扁平率ぶんで、細部の段と光路の上限にしか効かない)。
        const exit = sqrt(max(shellRadius.mul(shellRadius).sub(dot(offset, offset)).add(along.mul(along)), 0))
          .sub(along).mul(bodyRadius);
        const pathLength = clamp(exit, 0, MAX_LIGHT_PATH);
        // 積雲の柱ごとの透過率と、巻雲の層を抜けた光学的厚み。
        const cumulusTransmittance = float(1).toVar();
        const cirrusDepth = float(0).toVar();
        // 受け手の床は自分の積雲の柱のためのもの。積雲の影が無い設定で張ると、巻雲の層を跨ぐ
        // 高さの判定がずれる。
        const floorAltitude = this.receiverFloorAltitude(offset, bodyRadius).mul(this.cumulusActive);
        // 細部を運ぶ風は数百キロで均した流れなので、光路の数十キロのあいだは受け手の上で読んだ 1 つで足りる。
        const motion = this.fieldSampler.sampleMotion(normalize(offset));
        const surfaceWind = motion.surfaceWind.toVar();
        const upperWind = motion.upperWind.toVar();

        // **積雲のタップを、積雲が占めうる高度帯へ絞る。** 殻の上端まで均した間隔では、雲頂より
        // 上を通るタップは消える段を引くだけで影に寄らない。場の texel を読むだけの粗い前走で
        // 光路が通る範囲の積雲の雲頂の最大値と区間を拾い、細部を評価するタップはその区間だけへ
        // 柱の幅より細かい間隔で置く。細部で雲頂が伸びるぶんは不確かさぶん上乗せする。
        // 前走の本数は光路の長さに比例させる — 低い恒星で光路が伸びても間隔は変わらない。
        const coarseTapsFloat = clamp(ceil(pathLength.div(COARSE_STEP)),
          COARSE_TAPS_MIN, COARSE_TAPS_MAX);
        const coarseStep = pathLength.div(coarseTapsFloat);
        const coarseRadius = coarseStep.div(bodyRadius);
        const cumulusTop = float(0).toVar();
        // 積雲を拾ったタップの光路上の位置 [m] の幅。細部タップを置く区間のもとになる。
        const cumulusFirst = float(MAX_LIGHT_PATH).toVar();
        const cumulusLast = float(0).toVar();
        If(greaterThan(this.cumulusActive, 0.5), () => {
          Loop({ start: 0, end: int(coarseTapsFloat), type: 'int', condition: '<' }, ({ i }) => {
            const t = float(i).add(0.5);
            const sampleOffset = offset.add(rayDir.mul(coarseRadius.mul(t)));
            const up = sampleOffset.div(max(length(sampleOffset), 1e-6));
            const amount = this.fieldSampler.sampleField(up).r;
            If(greaterThan(amount, CUMULUS_PRESENT_AMOUNT), () => {
              cumulusTop.assign(max(cumulusTop,
                cumulusFieldTopNode(amount).mul(this.topAltitude)));
              const tm = coarseStep.mul(t);
              cumulusFirst.assign(min(cumulusFirst, tm));
              cumulusLast.assign(max(cumulusLast, tm));
            });
          });
        });
        // 光路に積雲が無ければ雲頂は 0 のままで、細部のループごと飛ばす。
        const cumulusCeiling = select(greaterThan(cumulusTop, 0),
          min(cumulusTop.add(this.topAltitude.mul(CloudShapeEvaluator.cloudTopUncertainty)),
            this.topAltitude),
          float(0));
        const cumulusRadius = float(1).add(cumulusCeiling.div(bodyRadius));
        const cumulusEnd = sqrt(max(
          cumulusRadius.mul(cumulusRadius).sub(dot(offset, offset)).add(along.mul(along)), 0))
          .sub(along).mul(bodyRadius).clamp(0, pathLength);
        // 細部タップの区間は、拾った位置の両側へ前走の間隔ぶん広げる — 拾い漏らしの縁と、
        // 按分が前後の半歩ぶん広がるぶんを覆う。上限は雲頂の殻を抜ける距離。積雲を拾えなかった
        // 光路では区間が潰れて、細部のループごと飛ばす。
        const cumulusFrom = max(cumulusFirst.sub(coarseStep), 0);
        const cumulusTo = min(cumulusLast.add(coarseStep), cumulusEnd);
        const cumulusSpan = max(cumulusTo.sub(cumulusFrom), 0);
        const cumulusTapsFloat = clamp(ceil(cumulusSpan.div(FINE_STEP)),
          SHADOW_TAPS, FINE_TAPS_MAX);
        const cumulusStep = cumulusSpan.div(cumulusTapsFloat);
        // タップ 1 回が代表する実寸。**歩がまたいだ柱は 1 タップが代表する**ので、画面 1 px の
        // 実寸と光路 1 歩の長さのうち粗いほうを取る。細部の段はこの幅で打ち切る。
        const cumulusWidth = max(footprint, cumulusStep.mul(STEP_BLUR));
        const cumulusFromRadius = cumulusFrom.div(bodyRadius);
        const cumulusStepRadius = cumulusStep.div(bodyRadius);
        If(greaterThan(cumulusSpan, 0), () => {
          Loop({ start: 0, end: int(cumulusTapsFloat), type: 'int', condition: '<' }, ({ i }) => {
            const sampleOffset = offset.add(rayDir.mul(
              cumulusFromRadius.add(cumulusStepRadius.mul(float(i).add(0.5)))));
            const sampleRadius = max(length(sampleOffset), 1e-6);
            const up = sampleOffset.div(sampleRadius);
            const altitude = max(sampleRadius.sub(1).mul(bodyRadius), floorAltitude);
            const cloud = this.fieldAt(up);
            // 細部はタップごとに、幅の上で解像できる段だけを重ねる。
            const detail = this.shape.detailAt(
              up, cumulusWidth, cloud.cumulus, (neighbor) => this.fieldAt(neighbor).cumulus,
              surfaceWind, this.shape.grainOf(cloud), cloud.cumulusCell);
            const cloudTop = this.shape.cloudTop(
              cumulusFieldTopNode(cloud.cumulus), detail).mul(this.topAltitude);
            const rise = max(dot(rayDir, up), 0).mul(cumulusStep);
            // texel を覆う割合と、その柱の中の光学的厚みが返す光の割合。覆う割合と柱の中の厚みは
            // 別の量で、厚みは細部を含む雲頂の高さから出す。
            const coverage = this.shape.opaqueFraction(cumulusOpacityNode(cloud.cumulus), detail);
            const reflected = coverage.mul(cloudReflectanceNode(
              cumulusInCloudOpticalDepthNode(cloudTop), LIQUID_CLOUD_ASYMMETRY));
            // **1 ステップが雲頂をまたぐ比率で按分する** — 雲頂の内外を 1 点で判じると、歩の数だけの段に
            // 割れた縞が影に出る。タップは歩の中点なので、稼いだ高度の半分が前後に広がる。
            const inside = clamp(cloudTop.sub(altitude).div(max(rise, 1)).add(0.5), 0, 1);
            const pathFraction = rise.mul(inside).div(max(cloudTop, 1));
            cumulusTransmittance.mulAssign(fractionalTransmittanceNode(
              reflected.mul(this.cumulusActive), pathFraction));
          });
        });

        // 巻雲は積雲のタップとは別に、層を抜ける全光路を同じ数の点で横切る。
        const cirrusStep = pathLength.div(SHADOW_TAPS);
        const cirrusStepRadius = cirrusStep.div(bodyRadius);
        const cirrusWidth = max(footprint, cirrusStep.mul(STEP_BLUR));
        Loop({ start: 0, end: SHADOW_TAPS, type: 'int', condition: '<' }, ({ i }) => {
          const sampleOffset = offset.add(rayDir.mul(cirrusStepRadius.mul(float(i).add(0.5))));
          const sampleRadius = max(length(sampleOffset), 1e-6);
          const up = sampleOffset.div(sampleRadius);
          const altitude = max(sampleRadius.sub(1).mul(bodyRadius), floorAltitude);
          const texel = this.fieldSampler.sampleField(up);
          const rise = max(dot(rayDir, up), 0).mul(cirrusStep);
          // 巻雲は、その場の量が雲頂高度へ写る薄い層。高度帯がその高さを跨ぐタップへ三角に
          // 分けて合計 1 回ぶんの横断になり、斜めの光路ぶん(stepLength/rise)伸ばした τ を足す。
          const cirrusCrossing = max(
            float(1).sub(abs(altitude.sub(cirrusTopAltitudeNode(texel.g))).div(max(rise, 1))), 0);
          // 筋の細部は、層を横切るタップで、その場所の筋の向きに沿って読む。
          const cirrusDetail = float(1).toVar();
          If(and(greaterThan(texel.g, CIRRUS_PRESENT_AMOUNT), greaterThan(cirrusCrossing, 0)), () => {
            // 型の領域と乾いた陸の判定は環境を要るので、層を横切るタップでだけ環境つきの標本を読む。
            const cloud = this.fieldAt(up);
            cirrusDetail.assign(this.cirrusDetail.multiplierAt(
              up, bodyRadius, cirrusWidth, cloud.cirrusFlow, upperWind,
              cirrusColumnInputOf(cloud)));
          });
          cirrusDepth.addAssign(cirrusColumnOpticalDepthNode(texel.g)
            .mul(cirrusDetail).mul(cirrusCrossing).mul(min(cirrusStep.div(max(rise, 1)), CIRRUS_MAX_SLANT))
            .mul(this.cirrusActive));
        });
        // 届く光は、積雲の柱ごとの透過率と巻雲の層の透過率の積。
        transmittance.assign(cumulusTransmittance
          .mul(float(1).sub(cloudReflectanceNode(cirrusDepth, ICE_CLOUD_ASYMMETRY))));
      });
      return transmittance;
    })();
  }

  // 大気の中の 1 点へ届く直射光の割合を、雲の層を少ないタップでたどる粗い推定として返す。
  // 大気積分はサンプル点ごとにこれを要るので、地表へ落とす影の transmittance() のように柱の
  // 形を細部まで解くのは重すぎる — 散乱の霞の中では柱の縁は読めず、影の濃さの空間分布だけ
  // あれば足りる。柱の形は細部を持たない場の値だけで、タップの配りは透過率の式と同じ。
  public ambientTransmittance(worldPos: Vec3Node): FloatNode {
    const sunDir = this.sunLight.directionFrom(worldPos);
    return Fn(() => {
      const transmittance = float(1).toVar();
      If(greaterThan(max(this.cumulusActive, this.cirrusActive), 0.5), () => {
        const bodyRadius = max(this.surfaceRadius, 1);
        const offset = this.toShellSpace(worldPos.sub(this.center));
        const rayDir = normalize(this.toShellSpace(sunDir));
        const shellRadius = float(1).add(this.topAltitude.div(bodyRadius));
        const along = dot(offset, rayDir);
        // 光路が殻を出るまでの距離(殻の空間の目盛り)。殻より上の点では負で、影は落ちない。
        const exit = sqrt(max(shellRadius.mul(shellRadius)
          .sub(dot(offset, offset)).add(along.mul(along)), 0)).sub(along);
        If(greaterThan(exit, 0), () => {
          const pathLength = min(exit.mul(bodyRadius), MAX_LIGHT_PATH);
          const step = pathLength.div(AMBIENT_TAPS);
          const stepRadius = step.div(bodyRadius);
          const cumulusTransmittance = float(1).toVar();
          const cirrusDepth = float(0).toVar();
          Loop({ start: 0, end: AMBIENT_TAPS, type: 'int', condition: '<' }, ({ i }) => {
            const sampleOffset = offset.add(rayDir.mul(stepRadius.mul(float(i).add(0.5))));
            const sampleRadius = max(length(sampleOffset), 1e-6);
            const up = sampleOffset.div(sampleRadius);
            const altitude = max(sampleRadius.sub(1).mul(bodyRadius), 0);
            const texel = this.fieldSampler.sampleField(up);
            const rise = max(dot(rayDir, up), 0).mul(step);
            // 積雲は、その方向の柱の雲頂がタップの高度より上なら、柱の中を通る割合で配分する。
            const cloudTop = cumulusFieldTopNode(texel.r).mul(this.topAltitude);
            const coverage = this.shape.opaqueFraction(cumulusOpacityNode(texel.r), float(1));
            const reflected = coverage.mul(cloudReflectanceNode(
              cumulusInCloudOpticalDepthNode(cloudTop), LIQUID_CLOUD_ASYMMETRY));
            const inside = clamp(cloudTop.sub(altitude).div(max(rise, 1)).add(0.5), 0, 1);
            const pathFraction = rise.mul(inside).div(max(cloudTop, 1));
            cumulusTransmittance.mulAssign(fractionalTransmittanceNode(
              reflected.mul(this.cumulusActive), pathFraction));
            // 巻雲は、その場所の層の高さを光路が跨ぐタップへ、斜めの光路ぶん伸ばした τ を足す。
            const cirrusCrossing = max(float(1)
              .sub(abs(altitude.sub(cirrusTopAltitudeNode(texel.g))).div(max(rise, 1))), 0);
            cirrusDepth.addAssign(cirrusColumnOpticalDepthNode(texel.g)
              .mul(cirrusCrossing).mul(min(step.div(max(rise, 1)), CIRRUS_MAX_SLANT))
              .mul(this.cirrusActive));
          });
          transmittance.assign(cumulusTransmittance
            .mul(float(1).sub(cloudReflectanceNode(cirrusDepth, ICE_CLOUD_ASYMMETRY))));
        });
      });
      return transmittance;
    })();
  }

  // 描画座標のベクトルを、殻が雲を立てるのと同じ空間へ写す — 地表が半径 1、雲頂が半径
  // 1 + 雲頂高度 / 基準半径 の球面に乗る空間。天体固定の向きへ回してから半軸で割る。
  // 真球のつもりで中心距離から高度を測ると、扁平な天体では緯度に応じたオフセット（誤差）が生じる(地球なら極で
  // 21 km — 雲の層 15 km より厚いので、極の雲頂が自分の柱の内側に沈み、恒星の向きによらず影になる)。
  private toShellSpace(worldVec: Vec3Node): Vec3Node {
    return this.bodyFromWorld.mul(vec4(worldVec, 0)).xyz.div(this.axes);
  }

  // 殻の空間の単位方向 up における場。uv は殻が読むのと共有 sampler の規則で引く — 別の規則で
  // 読むと、影が雲のシルエットから外れる。
  private fieldAt(up: Vec3Node): CloudSample {
    return this.fieldSampler.sampleCloud(up);
  }

  // 光路のタップの高度に張る床 [m]。受け手が自分の柱の雲頂の高さにあるなら、その雲頂の高さ。
  // offset は天体中心から受け手へのベクトル(殻の空間)、bodyRadius は殻の空間の半径 1 が
  // 張る高度の目盛り [m]。
  private receiverFloorAltitude(offset: Vec3Node, bodyRadius: FloatNode): FloatNode {
    const radius = max(length(offset), 1e-6);
    const altitude = max(radius.sub(1), 0).mul(bodyRadius);
    const top = cumulusFieldTopNode(this.fieldAt(offset.div(radius)).cumulus)
      .mul(this.topAltitude);
    const uncertainty = this.topAltitude.mul(CloudShapeEvaluator.cloudTopUncertainty);
    return select(greaterThan(altitude, top.sub(uncertainty)), top, float(0));
  }
}
