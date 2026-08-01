// 計画軌道の1区間(arc)。起点状態から終端時刻までを OrbitEntity で数値積分し、その保持
// サンプル列を1本の折れ線として描く。マニューバノードによる区間分割は知らない — 呼び出し側
// (PlanTrajectory)が arc ごとにこれを持つ。
import * as THREE from 'three/webgpu';
import { OrbitState, altitudeOf, keplerPeriod } from '../../physics/orbital';
import { OrbitEntity } from '../../physics/orbit-entity';
import { Frame } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';
import { len } from '../../physics/vec3';
import { FloatingOrigin } from '../floating-origin';
import { SampledLine } from '../../render/sampled-line';
import * as C from '../const';

// 積分の終端は要求時刻に対して丸め誤差ぶん手前に落ちうる。この幅までは終端そのものとみなす。
const EPOCH_EPS = 1e-6;

type ComputeKey = { state0: OrbitState; end: number; };

// 1周回あたりのステップ数。RK4 の誤差は1周あたりのステップ数でほぼ決まるので、これを固定すると
// 高度・離心率によらず精度が揃う(28日ぶんの LEO を積分して長半径誤差 1km 未満)。
const STEPS_PER_REV = 100;

// 刻み幅。その場の軌道運動の時間スケール(動径 r の円軌道周期)を STEPS_PER_REV 等分する。
// 低軌道では細かく、遠地点では粗くなり、離心軌道でも1周を通して精度が一定になる。
function stepDt(r: number): number {
  return keplerPeriod(r) / STEPS_PER_REV;
}

export class PlanArc {
  private readonly sampled: SampledLine;
  private entity: OrbitEntity | null = null;
  private samples: readonly OrbitState[] = [];
  // 再突入高度割れ・非有限で積分を打ち切ったか。
  private truncated = false;
  private key: ComputeKey | null = null;
  private lastComputeMs = -Infinity;

  // 描画色・不透明度・renderOrder を指定して線を用意する。
  constructor(color: number, opacity = 0.85, renderOrder = 4) {
    this.sampled = new SampledLine(color, opacity, renderOrder);
  }

  // シーンに追加する描画対象。
  get object3d(): THREE.Object3D {
    return this.sampled.line;
  }

  // 起点・終端の変化を検出してスロットル付きで再積分し、折れ線を現在の表示状態へ同期する。
  // endFollowsWindow は end が表示窓の終端(毎フレーム滑る)か、計画の角(編集時だけ動く)かの別。
  // force=true でスロットルを無視して即再積分する(窓の滑りと区別できない非連続な end 変化時)。
  update(
    state0: OrbitState,
    end: number,
    endFollowsWindow: boolean,
    ephemeris: Ephemeris,
    frame: Frame,
    currentTime: number,
    fo: FloatingOrigin,
    force = false,
  ): void {
    // 積分結果は (state0, end) だけで決まるので、変化したときにだけ回す。編集操作は
    // 高頻度なのでスロットルで間引き、毎フレーム滑る窓の終端はさらに長い間隔に落とす。
    const startEdited = this.key === null || state0 !== this.key.state0;
    const endMoved = this.key === null || end !== this.key.end;
    if (force || startEdited || endMoved) {
      const slidOnly = !startEdited && endFollowsWindow;
      const throttle = slidOnly ? C.PREDICT_REFRESH_INTERVAL_MS : C.PREDICT_DIRTY_THROTTLE_MS;
      const now = performance.now();
      if (force || now - this.lastComputeMs >= throttle) {
        this.integrate(state0, end, ephemeris);
        this.key = { state0, end };
        this.lastComputeMs = now;
      }
    }
    this.sampled.syncGeometry(this.samples, frame, ephemeris);
    this.sampled.syncTransform(frame, currentTime, ephemeris, fo);
  }

  // 時刻 t の状態。保持区間外は null。
  at(t: number): OrbitState | null {
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
  // 間引かれた解像度で残る。再突入高度を割るか非有限になったらそこで打ち切る。
  private integrate(state0: OrbitState, end: number, ephemeris: Ephemeris): void {
    const duration = Math.max(0, end - state0.t);
    const entity = new OrbitEntity(state0);
    const sampleInterval = duration / C.PREDICT_MAX_SAMPLES;
    this.truncated = false;

    let steps = 0;
    while (entity.state.t < end - EPOCH_EPS) {
      // 最後の1歩は end にちょうど着地させる — 終端がそのままノードの到達状態になる。
      const dt = Math.min(stepDt(len(entity.state.r)), end - entity.state.t);
      if (dt <= 1e-9) break;
      entity.step(dt, ephemeris, C.SHIP_BCINV, null, sampleInterval, duration);

      const alt = altitudeOf(entity.state.r);
      if (!isFinite(alt) || alt < C.REENTRY_ALT) {
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
