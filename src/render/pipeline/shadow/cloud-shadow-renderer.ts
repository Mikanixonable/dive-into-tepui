// 積雲の殻が落とす影。描画座標の点へ恒星の直射光がどれだけ届くかを、雲の層を抜ける光路の
// 消散の TSL グラフとして返す。影を落とす殻 1 体ぶんを毎フレーム set() で受ける。
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, clamp, dot, exp, float, greaterThan, length, max, normalize, select,
  sqrt, uniform, vec4,
} from 'three/tsl';
import { CloudFieldSampler } from '../../cloud/cloud-field-sampler';
import { cloudQualityPolicy } from '../../cloud/cloud-quality';
import type { CloudRenderInput } from '../../cloud/cloud-render-input';
import type { CloudSample } from '../../cloud/cloud-field-sample';
import {
  CLOUD_LIQUID_EDGE_M,
  CloudDensityEvaluator,
} from '../../cloud/cloud-density-evaluator';
import type { FloatNode, FloatUniform, Mat4Uniform, Vec3Node, Vec3Uniform } from '../../tsl-types';
import type { SunLight } from '../sun-light';

// 影を落とす積雲の殻 1 体ぶん。center は描画座標の天体中心、surfaceRadius は雲の高度の基準
// 半径 [m]、axes は天体固定の半軸 [m]、topAltitude は殻の高さ [m]、bodyFromWorld は描画座標の
// ベクトルを天体固定の向きへ回す行列、field は焼いた雲場と、それを焼いた cap の置き方の組。
export interface ShadowCumulus {
  readonly center: THREE.Vector3;
  readonly surfaceRadius: number;
  readonly axes: THREE.Vector3;
  readonly bodyFromWorld: THREE.Matrix4;
  readonly cloud: CloudRenderInput;
}

// 光路のタップ数。
const SHADOW_TAPS = 6;
// 光路をたどる長さの上限 [m]。恒星が地平線へ寄るほど層を抜けるまでの距離は伸び、昼夜境界の
// 真上で発散する。
const MAX_LIGHT_PATH = 3e5;
// 光路 1 歩が代表する幅を、場のぼかしへ何倍で写すか。**等倍では足りない** — 隣り合うタップの
// 覆う範囲が接するだけなので、あいだに影の抜けた縞が残る。
const STEP_BLUR = 2;

export class CloudShadowRenderer {
  private readonly center: Vec3Uniform;
  private readonly surfaceRadius: FloatUniform;
  private readonly axes: Vec3Uniform;
  private readonly topAltitude: FloatUniform;
  private readonly bodyFromWorld: Mat4Uniform;
  private readonly active: FloatUniform;
  private readonly detailFootprintScale: FloatUniform;
  // 雲場の読み取りと3D密度式は共有入力層へ置く。ここは太陽光路の透過率だけを所有する。
  private readonly fieldSampler = new CloudFieldSampler();
  private readonly density: CloudDensityEvaluator;

  // 殻 1 体ぶんの uniform を確保する。殻の有無は active で切るので、グラフの形は変わらない。
  public constructor(private readonly sunLight: SunLight) {
    this.center = uniform(new THREE.Vector3());
    this.surfaceRadius = uniform(0);
    // 場を持たないフレームでも殻の空間への写しは走るので、半軸は 0 で割らない値から始める。
    this.axes = uniform(new THREE.Vector3(1, 1, 1));
    this.topAltitude = uniform(0);
    this.bodyFromWorld = uniform(new THREE.Matrix4());
    this.active = uniform(0);
    this.detailFootprintScale = uniform(1);
    this.density = new CloudDensityEvaluator(this.surfaceRadius);
  }

  // このフレームに影を落とす殻。null なら雲の影は落ちない。
  public set(cumulus: ShadowCumulus | null): void {
    this.active.value = cumulus === null ? 0 : 1;
    if (cumulus === null) return;
    this.center.value.copy(cumulus.center);
    this.surfaceRadius.value = cumulus.surfaceRadius;
    this.axes.value.copy(cumulus.axes);
    this.topAltitude.value = cumulus.cloud.topAltitude;
    this.bodyFromWorld.value.copy(cumulus.bodyFromWorld);
    this.fieldSampler.bind(cumulus.cloud.field);
  }

  // このフレームに積雲の殻の影があるか。
  public casts(): boolean { return this.active.value > 0; }

  public setQuality(level: number): void {
    this.detailFootprintScale.value = cloudQualityPolicy(level).detailFootprintScale;
  }

  // 受け手から恒星へ向かう光路を、雲の層(地表から殻の上端まで)を抜けるまで殻の空間
  // (toShellSpace)でたどり、柱の雲頂より下を通る割合ぶんの消散を積む。
  //
  // 柱の光学的厚みも覆いの形も表面・大気と同じ CloudDensityEvaluator から引くので、
  // 影は同じ3D support の下へ落ちる。消散係数 [1/m] を実光路長で積分するため、鉛直に抜ければ
  // 柱光学深さ τ、斜めに抜ければ通過距離に応じてそれより大きい slant optical depth になる。
  // 受け手が自分の柱の雲頂の高さにいるときは、その柱で自分を陰らせない(receiverFloorAltitude)。
  // footprint は受け手の位置で画面 1 px が張る実寸 [m] で、粒の振幅を決める。
  public transmittance(worldPos: Vec3Node, footprint: FloatNode): FloatNode {
    const sunDir = this.sunLight.directionFrom(worldPos);
    return Fn(() => {
      const transmittance = float(1).toVar();
      // 場を持たないフレームで、タップぶんのフェッチを丸ごと飛ばす。
      If(greaterThan(this.active, 0.5), () => {
        const bodyRadius = max(this.surfaceRadius, 1);
        const offset = this.toShellSpace(worldPos.sub(this.center));
        // **光路の向きも殻の空間で取り直す** — 半軸で割ると向きが傾くので、描画座標の恒星方向を
        // そのまま使うと、光路が層を斜めに横切る量が緯度ぶんずれる。
        const rayDir = normalize(this.toShellSpace(sunDir));
        // 殻の上端の半径。地表が 1 なので、高さは基準半径で割った目盛りで乗る。
        const shellRadius = float(1).add(this.topAltitude.div(bodyRadius));
        const along = dot(offset, rayDir);
        // 光路が殻を出るまでの距離。殻より上の受け手では負になり、影は落ちない。長さは殻の空間の
        // 半径 1 を基準半径として測る(真の実寸との差は扁平率ぶんで、粒の振幅と光路の上限にしか効かない)。
        const exit = sqrt(max(shellRadius.mul(shellRadius).sub(dot(offset, offset)).add(along.mul(along)), 0))
          .sub(along).mul(bodyRadius);
        const stepLength = clamp(exit, 0, MAX_LIGHT_PATH).div(SHADOW_TAPS);
        // タップ 1 回が代表する実寸。**歩がまたいだ柱は 1 タップが代表する**ので、画面 1 px の
        // 実寸と光路 1 歩の長さのうち粗いほうを取る。粒の振幅はこの幅が決める。
        const sampleWidth = max(footprint, stepLength.mul(STEP_BLUR))
          .mul(this.detailFootprintScale);
        const floorAltitude = this.receiverFloorAltitude(offset, bodyRadius, sampleWidth);
        const stepRadius = stepLength.div(bodyRadius);
        const opticalDepth = float(0).toVar();
        Loop({ start: 0, end: SHADOW_TAPS, type: 'int', condition: '<' }, ({ i }) => {
          const sampleOffset = offset.add(rayDir.mul(stepRadius.mul(float(i).add(0.5))));
          const sampleRadius = max(length(sampleOffset), 1e-6);
          const up = sampleOffset.div(sampleRadius);
          const altitude = max(sampleRadius.sub(1).mul(bodyRadius), floorAltitude);
          const cloud = this.fieldAt(up);
          // 表面雲・大気雲と同じ3D消散係数を実距離で積分する。2 km detailはsampleWidthで
          // 自動的に帯域制限されるため、粗い光路で高周波だけがエイリアスすることもない。
          const density = this.density.sample(cloud, up, altitude, sampleWidth);
          opticalDepth.addAssign(density.extinctionPerM.mul(stepLength));
        });
        transmittance.assign(exp(opticalDepth.negate()));
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
  private receiverFloorAltitude(
    offset: Vec3Node, bodyRadius: FloatNode, footprintM: FloatNode,
  ): FloatNode {
    const radius = max(length(offset), 1e-6);
    const altitude = max(radius.sub(1), 0).mul(bodyRadius);
    const up = offset.div(radius);
    const top = this.density.liquidTopM(this.fieldAt(up), up, footprintM);
    return select(greaterThan(altitude, top.sub(CLOUD_LIQUID_EDGE_M)), top, float(0));
  }
}
