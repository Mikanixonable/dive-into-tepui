// シミュレーション速度(「ワープ」と呼ぶ)の段階管理と、「マニューバノードの実行時刻まで
// 自動的に加速する」機能を担う。
// マップビューの計画データそのものには依存しない — [N] キーの受け口と
// どのノード時刻へ自動ワープするかは呼び出し側が決めて渡す。
import { KinematicState } from '../../physics/kinematic-state';
import { KEY_MAPPING as K } from '../../input/key-mapping';
import { NODE_APPROACH_LEAD } from '../plan/plan';
import type { RunEventSink } from '../run-events';

// [N] 自動ワープ: 残り時間 / MARGIN 以下の最大シミュレーション速度を選び、STOP 秒前に解除。
export const SIM_SPEED_LEVELS = [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 131072, 524288, 2097152, 8388608, 33554432];
// 推進・射撃・交戦圏・敵AIが有効な最大タイムワープ(下の can* が参照)。
export const MAX_PHYS_SIM_SPEED = 4;

const AUTOWARP_MARGIN = 2;
const AUTOWARP_STOP = 10;

export class SimSpeedManager {
  private levelIdx = 0;
  private autoWarpUntil: number | null = null;

  constructor(private readonly events: RunEventSink) { }

  // 現在のワープ倍率。
  get simSpeed(): number {
    return SIM_SPEED_LEVELS[this.levelIdx]!;
  }

  // 自動ワープ中かどうか。
  get isAutoWarping(): boolean {
    return this.autoWarpUntil !== null;
  }

  // ノード自動ワープの到達時刻までの残りシミュレーション時間 [s]。
  // 表示用であり、自動ワープの段階制御は update() が担当する。
  remainingSimulationSeconds(simTime: number): number | null {
    if (this.autoWarpUntil === null) return null;
    return Math.max(0, this.autoWarpUntil - simTime);
  }

  // 現在のワープ倍率で自機の行動(推進・射撃・姿勢制御指令)と
  // 敵の射撃が成立するかどうか。呼び出し側は simSpeed そのものを受け取って
  // 閾値判定するのではなく、ここを見る。
  get canShipAct(): boolean {
    return this.simSpeed <= MAX_PHYS_SIM_SPEED;
  }

  // 現在のワープ倍率で交戦圏が存在するかどうか。
  get canEngage(): boolean {
    return this.simSpeed <= MAX_PHYS_SIM_SPEED;
  }

  // 現在のワープ倍率で補給を投入してよいかどうか。等倍(実時間)のときだけ投入するのは、
  // 補給が「接近して回収する」操作を前提にした投入であり、時間を進めている間も投入だけが
  // 続くと、回収されないまま軌道上に溜まり続けるため。
  get canResupplyAmmo(): boolean {
    return this.simSpeed === 1;
  }

  // ワープ段を step 分だけ変更する。上下限を超える変更は無視する。
  shift(step: number): void {
    const next = this.levelIdx + step;
    if (next < 0 || next >= SIM_SPEED_LEVELS.length) return;
    this.setSpeed(SIM_SPEED_LEVELS[next]!);
  }

  // UI のプルダウンから選ばれた時間加速倍率を適用する。
  setSpeed(speed: number): void {
    const next = SIM_SPEED_LEVELS.indexOf(speed);
    if (next < 0 || next === this.levelIdx) return;
    this.cancelAutoWarp();
    this.levelIdx = next;
    this.events.record({ kind: 'simSpeedChanged', speed: this.simSpeed, shipActs: this.canShipAct });
  }

  // simTime を現在時刻として、時刻 time が自動ワープで目指せる未来かどうか。
  public canAutoWarpTo(time: number, simTime: number): boolean {
    return isFinite(time) && time > simTime + NODE_APPROACH_LEAD;
  }

  // 未来の指定時刻まで自動ワープする。既に到達窓へ入った時刻は受け付けない。
  startAutoWarpTo(time: number, simTime: number): boolean {
    if (!this.canAutoWarpTo(time, simTime)) return false;
    this.autoWarpUntil = time;
    return true;
  }

  // 自動ワープを解除する。
  cancelAutoWarp(): void {
    this.autoWarpUntil = null;
  }

  // router から [,]/[.] の単発入力を受け取ってワープ段を上下する。
  handleCommand(commandId: string): void {
    if (commandId === K.warpSlower.code) this.shift(-1);
    if (commandId === K.warpFaster.code) this.shift(1);
  }

  // 直近ノードの実行時刻までの自動ワープをトグルする。
  toggleAutoWarpToFirstNode(firstNode: KinematicState | undefined, simTime: number): void {
    // ノードがなければ、起こせなかったこととその理由だけを記録する
    if (!firstNode) {
      this.events.record({ kind: 'autoWarpUnavailable', reason: 'noNode' });
      return;
    }
    // 自動ワープ中なら解除、そうでなければノードの時刻まで開始する
    if (this.isAutoWarping) {
      this.cancelAutoWarp();
      this.events.record({ kind: 'autoWarpCancelled' });
    } else if (this.startAutoWarpTo(firstNode.t, simTime)) {
      this.events.record({ kind: 'autoWarpStarted' });
    } else {
      this.events.record({ kind: 'autoWarpUnavailable', reason: 'nodePassed' });
    }
  }

  // 残り時間に応じてシミュレーション速度を自動的に段階調整し、
  // 実行の窓に入ったら等倍へ戻して解除する。
  update(simTime: number): void {
    if (this.autoWarpUntil === null) return;
    const tRem = this.autoWarpUntil - simTime;
    if (tRem <= NODE_APPROACH_LEAD) {
      this.autoWarpUntil = null;
      this.levelIdx = 0;
      // ここで return せずループへ落ちると、解除した直後の tRem からもう一度
      // 段を再計算してしまい、×1 に戻したばかりの levelIdx を同じフレームで
      // 上書きしてしまう。
      return;
    }
    let idx = 0;
    for (let i = 0; i < SIM_SPEED_LEVELS.length; i++) {
      if (SIM_SPEED_LEVELS[i]! <= tRem / AUTOWARP_MARGIN) idx = i;
    }
    this.levelIdx = idx;
  }

  // 自動ワープが解除されるまでの残り実時間 [s] を見積もる。update() と同じ段選択規則
  // (tRem/AUTOWARP_MARGIN 以下の最大段)のもとで、残りシミュレーション時間を消化する間に
  // 段が繰り返し下がっていく過程を積算する — 現在の段のまま進むと仮定した単純な tRem/simSpeed
  // では、高倍率区間が短く低倍率区間が長い実態から大きく外れるため。自動ワープ中でなければ null。
  estimatedRealSecondsToWarpEnd(simTime: number): number | null {
    if (this.autoWarpUntil === null) return null;
    let tRem = this.autoWarpUntil - simTime;
    if (tRem <= AUTOWARP_STOP) return 0;
    let realSec = 0;
    for (let i = SIM_SPEED_LEVELS.length - 1; i >= 0; i--) {
      const s = SIM_SPEED_LEVELS[i]!;
      if (s > tRem / AUTOWARP_MARGIN) continue;
      const lowerBound = Math.max(AUTOWARP_STOP, s * AUTOWARP_MARGIN);
      if (tRem <= lowerBound) continue;
      realSec += (tRem - lowerBound) / s;
      tRem = lowerBound;
    }
    return realSec;
  }
}
