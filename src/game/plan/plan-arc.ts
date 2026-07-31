// 計画軌道の1区間(arc)。起点状態から終端時刻までを OrbitEntity で数値積分し、その保持
// サンプル列を1本の折れ線として描く。マニューバノードによる区間分割は知らない — 呼び出し側
// (PlanTrajectory)が arc ごとにこれを持つ。
import * as THREE from 'three/webgpu';
import { OrbitState, altitudeOf } from '../../physics/orbital';
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

// 刻み幅。動径が小さいほど細かく(LEO で約8.5s)、表示期間が長いほど粗くする。28日ぶんを
// LEO の秒刻みで積分すると RK4 が数十万ステップに達し、1回の再計算に数百 ms かかる。
// 計画・表示用途なので、遠い将来ぶんが粗いことは実用上問題にならない。
function stepDt(r: number, duration: number): number {
  const coarsen = Math.max(1, Math.min(8, duration / 86400));
  return Math.max(5, Math.min(600, (r / 8e5) * coarsen));
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
  constructor(color: number, opacity = 0.85, renderOrder = 2) {
    this.sampled = new SampledLine(color, opacity, renderOrder);
  }

  // シーンに追加する描画対象。
  get object3d(): THREE.Object3D {
    return this.sampled.line;
  }

  // 起点・終端の変化を検出してスロットル付きで再積分し、折れ線を現在の表示状態へ同期する。
  // force=true でスロットルを無視して即再積分する(窓の滑りと区別できない非連続な end 変化時)。
  update(
    state0: OrbitState,
    end: number,
    ephemeris: Ephemeris,
    frame: Frame,
    currentTime: number,
    fo: FloatingOrigin,
    force = false,
  ): void {
    // 起点の編集か、表示終端の窓の移動かでスロットル間隔を変える
    const edited = this.key === null || state0 !== this.key.state0;
    const windowMoved = this.key === null || end !== this.key.end;
    if (force || edited || windowMoved) {
      const now = performance.now();
      const throttle = edited ? C.PREDICT_DIRTY_THROTTLE_MS : C.PREDICT_REFRESH_INTERVAL_MS;
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

    while (entity.state.t < end - EPOCH_EPS) {
      const dt = Math.min(stepDt(len(entity.state.r), duration), end - entity.state.t);
      if (dt <= 1e-9) break;
      const mid = entity.state.t + dt / 2;
      const sunPos = ephemeris.sunPosAt(mid);
      const moonPos = ephemeris.moonPosAt(mid);
      entity.step(dt, sunPos, moonPos, C.SHIP_BCINV, null, sampleInterval, duration);

      const alt = altitudeOf(entity.state.r);
      if (!isFinite(alt) || alt < C.REENTRY_ALT) {
        this.truncated = true;
        break;
      }
    }

    this.entity = entity;
    this.samples = entity.samplesOldestFirst();
  }
}
