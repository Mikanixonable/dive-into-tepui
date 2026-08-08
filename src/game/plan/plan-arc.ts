// 計画軌道の1区間(arc)。起点状態から終端時刻までを DynamicTrajectory で数値積分し、その保持
// サンプル列を1本の折れ線として描く。マニューバノードによる区間分割は知らない — 呼び出し側
// (PlanPath)が arc ごとにこれを持つ。
import * as THREE from 'three/webgpu';
import { KinematicState, hermiteInterpolate } from '../../physics/kinematic-state';
import { DynamicTrajectory } from '../../physics/dynamic-trajectory';
import { ReferenceFrame } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';
import { Attractor, hitAttractor, localOrbitPeriod } from '../../physics/attractor';
import { Vec3 } from '../../physics/vec3';
import { FloatingOrigin } from '../floating-origin';
import { SampledLine } from '../../render/sampled-line';
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
  // 天体衝突後、その天体を無視して伝播を続けた仮想延長線(幽霊軌道)。破線で描く。
  private readonly ghostLine: SampledLine;
  private readonly group = new THREE.Group();
  private trajectory: DynamicTrajectory | null = null;
  private _samples: readonly KinematicState[] = [];
  // _samples を衝突地点で分けた前半・後半(未衝突なら後半は空)。sync() が毎フレーム
  // 参照するので、再積分のたび(integrate())にだけ作り直す。
  private preImpactSamples: readonly KinematicState[] = [];
  private postImpactSamples: readonly KinematicState[] = [];
  // 積分中に最初に天体表面へ達した状態。以降はその天体を除いて伝播を続ける。到達しなければ null。
  private impactState: KinematicState | null = null;
  // 非有限・2つ目の(別の)天体への衝突・ステップ数上限で積分を打ち切ったか。
  private truncated = false;
  private key: ComputeKey | null = null;
  private recomputed = false;

  // 描画色・不透明度・renderOrder を指定して線を用意する。
  constructor(color: number, opacity = 0.85, renderOrder = 4) {
    this.line = new SampledLine(color, opacity, renderOrder);
    this.ghostLine = new SampledLine(color, opacity * C.PLAN_ARC_GHOST_OPACITY_MULT, renderOrder,
      { dashSize: C.PLAN_ARC_GHOST_DASH_M, gapSize: C.PLAN_ARC_GHOST_GAP_M });
    this.group.add(this.line.line, this.ghostLine.line);
  }

  // シーンに追加する描画対象。
  get object3d(): THREE.Object3D {
    return this.group;
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
  update(state0: KinematicState, end: number, ephemeris: Ephemeris, tracksLiveAnchor: boolean): void {
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
      this.integrate(state0, end, ephemeris);
      this.key = { state0, end };
    }
  }

  // 直近の update() で実際に再積分したか。呼び出し側が再積分に連動するキャッシュを
  // 持つときの判定に使う。
  didRecompute(): boolean {
    return this.recomputed;
  }

  // 直近に積分したサンプル列を折れ線メッシュへ反映する。衝突があった区間は、衝突地点までを
  // 実線、そこから先(仮想延長線)を破線の別メッシュへ分けて描く。
  sync(ephemeris: Ephemeris, frame: ReferenceFrame, currentTime: number, fo: FloatingOrigin): void {
    this.line.syncGeometry(this.preImpactSamples, frame, ephemeris);
    this.line.syncTransform(frame, currentTime, ephemeris, fo);
    this.ghostLine.syncGeometry(this.postImpactSamples, frame, ephemeris);
    this.ghostLine.syncTransform(frame, currentTime, ephemeris, fo);
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

  // 終端(= 次のノードの噴射直前)の状態。終端まで到達できなかった区間は null。天体に
  // 衝突した区間でも、それ以降を仮想延長線として伝播できていれば終端状態を返す。
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
    this.ghostLine.setVisible(v);
  }

  // 保持している描画リソースを破棄する。
  dispose(): void {
    this.line.dispose();
    this.ghostLine.dispose();
  }

  // state0 から end まで自機と同じ弾道係数で自由伝播し、サンプル列を作り直す。
  // 保持間隔は区間長を上限サンプル数で割った値、保持窓は区間長そのものなので、区間全体が
  // 間引かれた解像度で残る。
  // いずれかの天体の表面 + REENTRY_ALT を割ったら、その天体を以降の重力源・大気抵抗の対象から
  // 除いて伝播を続ける(衝突地点より先は「その天体が無かったら」の仮想延長線として描く —
  // 呼び出し側 sync() が実線/破線を分けるための境界として impactState を使う)。除いた天体とは
  // 別の天体にも達すれば、そこで本当に打ち切る(2つ目の衝突まで幽霊軌道を重ねる意味は無い)。
  // 非有限になった場合も同様に打ち切る。
  private integrate(state0: KinematicState, end: number, ephemeris: Ephemeris): void {
    const duration = Math.max(0, end - state0.t);
    const trajectory = new DynamicTrajectory(state0);
    const sampleInterval = duration / C.PLAN_ARC_MAX_SAMPLES;
    this.truncated = false;
    this.impactState = null;
    let impactBody: Attractor | null = null;

    let steps = 0;
    while (trajectory.state.t < end - EPOCH_EPS) {
      const sizingAttractors = ephemeris.attractorsAt(trajectory.state.t);
      // 最後の1歩は end にちょうど着地させる — 終端がそのままノードの到達状態になる。
      const dt = Math.min(stepDt(trajectory.state.r, sizingAttractors), end - trajectory.state.t);
      if (dt <= 1e-9) break;
      const stepAttractors = ephemeris.attractorsAt(trajectory.state.t + dt / 2);
      const activeAttractors = impactBody ? stepAttractors.filter((a) => a.id !== impactBody!.id) : stepAttractors;
      trajectory.step(dt, activeAttractors, impactBody ? 0 : C.SHIP_BCINV, C.SHIP_SRP_COEFF, C.SHADOW_PENUMBRA, null, sampleInterval, duration);

      const { r, v } = trajectory.state;
      const finite = Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z)
        && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
      if (!finite) {
        this.truncated = true;
        break;
      }
      const hit = hitAttractor(r, activeAttractors, C.REENTRY_ALT);
      if (hit) {
        if (impactBody === null) {
          impactBody = hit;
          this.impactState = trajectory.state;
        } else {
          this.truncated = true;
          break;
        }
      }
      if (++steps >= C.PLAN_ARC_MAX_STEPS) {
        this.truncated = true;
        break;
      }
    }

    this.trajectory = trajectory;
    this._samples = trajectory.samplesOldestFirst();
    this.splitSamplesAtImpact();
  }

  // _samples を impactState の時刻で前半・後半へ分ける。衝突が無ければ全部前半、後半は空。
  // 衝突時刻ぴったりのサンプルが decimation で残っているとは限らないので、衝突時刻以降で
  // 最初に残っているサンプルを境界にする(前半・後半はその1点を共有し、線が繋がって見える)。
  private splitSamplesAtImpact(): void {
    if (!this.impactState) {
      this.preImpactSamples = this._samples;
      this.postImpactSamples = [];
      return;
    }
    const idx = this._samples.findIndex((s) => s.t >= this.impactState!.t);
    const boundary = idx < 0 ? this._samples.length - 1 : idx;
    this.preImpactSamples = this._samples.slice(0, boundary + 1);
    this.postImpactSamples = this._samples.slice(boundary);
  }
}
