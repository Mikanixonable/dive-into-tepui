// 計画軌道の1区間(arc)。起点状態から終端時刻までを DynamicTrajectory で数値積分し、その保持
// サンプル列を1本の折れ線として描く。マニューバノードによる区間分割は知らない — 呼び出し側
// (PlanPath)が arc ごとにこれを持つ。
import type * as THREE from 'three/webgpu';
import { KinematicState, hermiteInterpolate } from '../../physics/kinematic-state';
import { DynamicTrajectory } from '../../physics/dynamic-trajectory';
import { ReferenceFrame } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';
import { Attractor, hitAttractor, localOrbitPeriod } from '../../physics/attractor';
import { attractorsNear, classifyAttractors, gravityBodiesAt, mergeAttractors } from '../simulation/attractors';
import { Vec3 } from '../../physics/vec3';
import { FloatingOrigin } from '../floating-origin';
import { SampledLine } from '../../render/sampled-line';
import { ScaleFn } from '../camera/camera-system';
import * as C from '../const';

// 積分の終端は要求時刻に対して丸め誤差ぶん手前に落ちうる。この幅までは終端そのものとみなす。
const EPOCH_EPS = 1e-6;

type ComputeKey = { state0: KinematicState; end: number; };

// 刻み幅。その場で最も強く引く天体を中心とする軌道運動の時間スケールを
// PLAN_ARC_STEPS_PER_REV 等分する。
// 低軌道では細かく、遠地点では粗くなり、離心軌道でも1周を通して精度が一定になる。
function stepDt(r: Vec3, attractors: readonly Attractor[]): number {
  return localOrbitPeriod(r, attractors) / C.PLAN_ARC_STEPS_PER_REV;
}

export class PlanArc {
  private readonly line: SampledLine;
  private trajectory: DynamicTrajectory | null = null;
  private _samples: readonly KinematicState[] = [];
  // 積分中に最初に天体表面へ達した状態。到達しなければ null。
  private impactState: KinematicState | null = null;
  // 非有限・天体衝突・ステップ数上限で積分を打ち切ったか。
  private truncated = false;
  private key: ComputeKey | null = null;
  private recomputed = false;

  // 描画色・不透明度・renderOrder を指定して線を用意する。折れ線は常に破線で描く
  // (実際のパターンは sync() が毎フレーム上書きするので、ここでの初期値に意味は無い)。
  constructor(color: number, opacity = 0.85, renderOrder = 4) {
    this.line = new SampledLine(color, opacity, renderOrder,
      { dashSize: C.PLAN_ARC_DASH_PX, gapSize: C.PLAN_ARC_GAP_PX });
  }

  // シーンに追加する描画対象。
  get object3d(): THREE.Object3D {
    return this.line.line;
  }

  // 積分中に最初に天体表面へ達した状態。到達しなければ null。
  impactPoint(): KinematicState | null {
    return this.impactState;
  }

  // 起点・終端の変化を検出して再積分する。tracksLiveAnchor(計画が空の間の唯一の区間)では
  // state0 が自機を毎フレーム追従して end も連動して動く。'orbit' プリセットでは区間長
  // (= 起点の接触周期)自体も J2・大気抵抗で毎フレーム連続的に変化するため、区間長・
  // state0.t のどちらも厳密一致では判定できない。そこで両者とも同じ基準
  // ——直近の再積分結果からの変化が描画解像度のサンプル間隔(区間長 / PLAN_ARC_MAX_SAMPLES)
  // 未満かどうか——で揃えて判定する: それ未満なら折れ線の見た目は変わらないので再積分を
  // スキップする。ただし起点の同一性が変わっていて、かつ時刻が前進していない場合(別艦への
  // 切り替え・ドック発進・衝突による状態上書きなど、同じ時刻での非連続な差し替え)は、
  // 差分がどれだけ小さくても即座に再積分する — そうしないと切り替え直後の1フレームが
  // 前の起点と時刻的に近いというだけで、無関係な軌道をサンプル間隔ぶん描き続けてしまう。
  // tracksLiveAnchor でなければ state0/end の同一性・値の変化で即座に再積分する
  // (ノードの Δv 編集は state0 の同一性変化で必ず拾われる)。
  update(
    state0: KinematicState, end: number, ephemeris: Ephemeris,
    dynamicAttractors: readonly Attractor[], tracksLiveAnchor: boolean,
  ): void {
    if (tracksLiveAnchor) {
      // 同一性が変わっても時刻が前進していれば通常の追従とみなし、下のサンプル間隔判定に委ねる。
      const anchorSwapped = this.key !== null && state0 !== this.key.state0 && state0.t <= this.key.state0.t;
      const duration = end - state0.t;
      const keyDuration = this.key ? this.key.end - this.key.state0.t : NaN;
      const sampleInterval = this.key ? keyDuration / C.PLAN_ARC_MAX_SAMPLES : 0;
      const durationChanged = this.key === null || Math.abs(duration - keyDuration) >= sampleInterval;
      const anchorDrifted = this.key !== null && Math.abs(state0.t - this.key.state0.t) >= sampleInterval;
      this.recomputed = anchorSwapped || durationChanged || anchorDrifted;
    } else {
      this.recomputed = this.key === null || state0 !== this.key.state0 || end !== this.key.end;
    }
    if (this.recomputed) {
      this.integrate(state0, end, ephemeris, dynamicAttractors);
      this.key = { state0, end };
    }
  }

  // 直近に積分したサンプル列を折れ線メッシュへ反映する。
  sync(ephemeris: Ephemeris, frame: ReferenceFrame, currentTime: number, fo: FloatingOrigin,
    dashSize: number, gapSize: number, scale: ScaleFn, attractors: readonly Attractor[]): void {
    this.line.setDash(dashSize, gapSize);
    this.line.syncGeometry(this._samples, frame, ephemeris, scale, attractors);
    this.line.syncTransform(frame, currentTime, ephemeris, fo, attractors);
  }

  // 時刻 t の状態。保持区間外は null。
  at(t: number): KinematicState | null {
    if (this.trajectory === null) {
      for (let i = 1; i < this._samples.length; i++) {
        const a = this._samples[i - 1]!, b = this._samples[i]!;
        if (t >= a.t && t <= b.t) return hermiteInterpolate(a, b, t);
      }
      return this._samples.length && t === this._samples[this._samples.length - 1]!.t ? this._samples[this._samples.length - 1]! : null;
    }
    if (this.trajectory === null) return null;
    const tip = this.trajectory.state;
    if (t > tip.t) return t - tip.t <= EPOCH_EPS ? tip : null;
    return this.trajectory.at(t);
  }

  // 終端(= 次のノードの噴射直前)の状態。終端まで到達できなかった区間は null。
  endState(): KinematicState | null {
    return this.truncated || this.trajectory === null ? null : this.trajectory.state;
  }

  // 直近に積分したサンプル列。
  get samples(): readonly KinematicState[] {
    return this._samples;
  }

  // 線の表示/非表示を切り替える。
  setVisible(v: boolean): void {
    this.line.setVisible(v);
  }

  // 保持している描画リソースを破棄する。
  dispose(): void {
    this.line.dispose();
  }

  // state0 から end まで自機と同じ弾道係数で自由伝播し、サンプル列を作り直す。保持間隔は
  // 区間長を上限サンプル数で割った値、保持窓は区間長そのものなので、区間全体が間引かれた
  // 解像度で残る。いずれかの天体の表面 + REENTRY_ALT を割ったら、その時点で打ち切る
  // (非有限・ステップ数上限に達した場合も同様)。
  // dynamicAttractors は呼び出し元がこのフレームで一度だけ求めた値を全ステップで使い回す —
  // 区間長は最大1年に及び、そのあいだの位置を EntityManager には問えないため。
  private integrate(
    state0: KinematicState, end: number, ephemeris: Ephemeris, dynamicAttractors: readonly Attractor[],
  ): void {
    const duration = Math.max(0, end - state0.t);
    const trajectory = new DynamicTrajectory(state0);
    const sampleInterval = duration / C.PLAN_ARC_MAX_SAMPLES;
    this.truncated = false;
    this.impactState = null;

    let steps = 0;
    while (trajectory.state.t < end - EPOCH_EPS) {
      const sizingClassified = classifyAttractors(
        mergeAttractors(gravityBodiesAt(ephemeris, trajectory.state.t), dynamicAttractors));
      const sizingAttractors = attractorsNear(trajectory.state.r, sizingClassified);
      // 最後の1歩は end にちょうど着地させる — 終端がそのままノードの到達状態になる。
      const dt = Math.min(stepDt(trajectory.state.r, sizingAttractors), end - trajectory.state.t);
      if (dt <= 1e-9) break;
      // 積分そのものはステップ中点(t + dt/2)の重力源で評価する。
      const stepClassified = classifyAttractors(
        mergeAttractors(gravityBodiesAt(ephemeris, trajectory.state.t + dt / 2), dynamicAttractors));
      const stepAttractors = attractorsNear(trajectory.state.r, stepClassified);
      trajectory.step(dt, stepAttractors, C.SHIP_BCINV, C.SHIP_SRP_COEFF, C.SHADOW_PENUMBRA, null, sampleInterval, duration);

      const { r, v } = trajectory.state;
      const finite = Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z)
        && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
      if (!finite) {
        this.truncated = true;
        break;
      }
      const hit = hitAttractor(r, stepAttractors, C.REENTRY_ALT);
      if (hit) {
        this.impactState = trajectory.state;
        this.truncated = true;
        break;
      }
      if (++steps >= C.PLAN_ARC_MAX_STEPS) {
        this.truncated = true;
        break;
      }
    }

    this.trajectory = trajectory;
    this._samples = trajectory.samplesOldestFirst();
  }
}
