// 計画軌道の1区間(arc)。起点状態から終端時刻までを OrbitEntity で数値積分し、その保持
// サンプル列を1本の折れ線として描く。マニューバノードによる区間分割は知らない — 呼び出し側
// (PlanTrajectory)が arc ごとにこれを持つ。
import * as THREE from 'three/webgpu';
import { OrbitState, hermiteInterpolate } from '../../physics/orbital-state';
import { OrbitEntity } from '../../physics/orbit-entity';
import { ReferenceFrame } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';
import { Attractor, hitsAnySurface, localOrbitPeriod } from '../../physics/attractor';
import { Vec3 } from '../../physics/vec3';
import { FloatingOrigin } from '../floating-origin';
import { SampledLine } from '../../render/sampled-line';
import * as C from '../const';

// 積分の終端は要求時刻に対して丸め誤差ぶん手前に落ちうる。この幅までは終端そのものとみなす。
const EPOCH_EPS = 1e-6;

type ComputeKey = { state0: OrbitState; end: number; };

// 刻み幅。その場で最も強く引く天体を中心とする軌道運動の時間スケールを
// PLAN_ARC_STEPS_PER_REV 等分する。
// 低軌道では細かく、遠地点では粗くなり、離心軌道でも1周を通して精度が一定になる。
function stepDt(r: Vec3, bodies: readonly Attractor[]): number {
  return localOrbitPeriod(r, bodies) / C.PLAN_ARC_STEPS_PER_REV;
}

export class PlanArc {
  private readonly sampled: SampledLine;
  private entity: OrbitEntity | null = null;
  private samples: readonly OrbitState[] = [];
  // 再突入高度割れ・非有限で積分を打ち切ったか。
  private truncated = false;
  private key: ComputeKey | null = null;
  private recomputed = false;

  // 描画色・不透明度・renderOrder を指定して線を用意する。
  constructor(color: number, opacity = 0.85, renderOrder = 4) {
    this.sampled = new SampledLine(color, opacity, renderOrder);
  }

  // シーンに追加する描画対象。
  get object3d(): THREE.Object3D {
    return this.sampled.line;
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
  update(state0: OrbitState, end: number, ephemeris: Ephemeris, tracksLiveAnchor: boolean): void {
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

  // 直近に積分したサンプル列を折れ線メッシュへ反映する。
  sync(ephemeris: Ephemeris, frame: ReferenceFrame, currentTime: number, fo: FloatingOrigin): void {
    this.sampled.syncGeometry(this.samples, frame, ephemeris);
    this.sampled.syncTransform(frame, currentTime, ephemeris, fo);
  }

  // 時刻 t の状態。保持区間外は null。
  at(t: number): OrbitState | null {
    if (this.entity === null) {
      for (let i = 1; i < this.samples.length; i++) {
        const a = this.samples[i - 1]!, b = this.samples[i]!;
        if (t >= a.t && t <= b.t) return hermiteInterpolate(a, b, t);
      }
      return this.samples.length && t === this.samples[this.samples.length - 1]!.t ? this.samples[this.samples.length - 1]! : null;
    }
    if (this.entity === null) return null;
    const tip = this.entity.state;
    if (t > tip.t) return t - tip.t <= EPOCH_EPS ? tip : null;
    return this.entity.at(t);
  }

  // 終端(= 次のノードの噴射直前)の状態。終端まで到達できなかった区間は null。
  endState(): OrbitState | null {
    return this.truncated || this.entity === null ? null : this.entity.state;
  }

  // 直近に積分したサンプル列。
  samplesRef(): readonly OrbitState[] {
    return this.samples;
  }

  // 線の表示/非表示を切り替える。
  setVisible(v: boolean): void {
    this.sampled.setVisible(v);
  }

  // 保持している描画リソースを破棄する。
  dispose(): void {
    this.sampled.dispose();
  }

  // state0 から end まで自機と同じ弾道係数で自由伝播し、サンプル列を作り直す。
  // 保持間隔は区間長を上限サンプル数で割った値、保持窓は区間長そのものなので、区間全体が
  // 間引かれた解像度で残る。いずれかの天体の表面 + REENTRY_ALT を割るか非有限になったら
  // そこで打ち切る。
  private integrate(state0: OrbitState, end: number, ephemeris: Ephemeris): void {
    const duration = Math.max(0, end - state0.t);
    const entity = new OrbitEntity(state0);
    const sampleInterval = duration / C.PLAN_ARC_MAX_SAMPLES;
    this.truncated = false;

    let steps = 0;
    while (entity.state.t < end - EPOCH_EPS) {
      const sizingBodies = ephemeris.attractorsAt(entity.state.t);
      // 最後の1歩は end にちょうど着地させる — 終端がそのままノードの到達状態になる。
      const dt = Math.min(stepDt(entity.state.r, sizingBodies), end - entity.state.t);
      if (dt <= 1e-9) break;
      const bodies = ephemeris.attractorsAt(entity.state.t + dt / 2);
      entity.step(dt, bodies, C.SHIP_BCINV, null, sampleInterval, duration);

      const { r, v } = entity.state;
      const finite = Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z)
        && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
      if (!finite || hitsAnySurface(r, bodies, C.REENTRY_ALT)) {
        this.truncated = true;
        break;
      }
      if (++steps >= C.PLAN_ARC_MAX_STEPS) {
        this.truncated = true;
        break;
      }
    }

    this.entity = entity;
    this.samples = entity.samplesOldestFirst();
  }
}
