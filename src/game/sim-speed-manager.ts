// シミュレーション速度(HUD ヒント・SFX 上は「ワープ」と呼ぶ)の段階管理と、
// [N] キーによる「マニューバノードの実行時刻まで自動的に加速する」機能を担う。
// マップモードの計画データそのものには依存しない — どのノード時刻へ
// 自動ワープするかは呼び出し側(game.ts / PlanEditor)が決めて渡す。
import * as C from './const';
import { Hud } from './hud/hud';
import { Sfx } from '../audio/sfx';
import { OrbitState } from '../physics/orbital';
import type { Input } from './input/input';
import { KEY_MAPPING as K } from './input/key-mapping';

export class SimSpeedManager {
  private levelIdx = 0;
  private autoWarpUntil: number | null = null;

  constructor(
    private readonly _hud: Hud,
    private readonly _sfx: Sfx,
  ) { }

  // 現在のワープ倍率。
  get simSpeed(): number {
    return C.SIM_SPEED_LEVELS[this.levelIdx]!;
  }

  // 自動ワープ中かどうか。
  get isAutoWarping(): boolean {
    return this.autoWarpUntil !== null;
  }

  // 現在のワープ倍率で物理的な相互作用(推進・射撃・衝突・敵AI)が有効かどうか。
  // 呼び出し側は simSpeed そのものを受け取って閾値判定するのではなく、ここを見る。
  get canPlayerThrust(): boolean {
    return this.simSpeed <= C.MAX_PHYS_SIM_SPEED;
  }

  // 現在のワープ倍率で自機の射撃が有効かどうか。
  get canPlayerFire(): boolean {
    return this.simSpeed <= C.MAX_PHYS_SIM_SPEED;
  }

  // 現在のワープ倍率で敵の射撃が有効かどうか。
  get canEnemyFire(): boolean {
    return this.simSpeed <= C.MAX_PHYS_SIM_SPEED;
  }

  // 現在のワープ倍率で剛体衝突を解決してよいかどうか。
  get canResolvePhysicalCollisions(): boolean {
    return this.simSpeed <= C.MAX_PHYS_SIM_SPEED;
  }

  // ワープ段を step 分だけ変更する。上下限を超える変更は無視する。
  shift(step: number): void {
    this.cancelAutoWarp();
    const next = this.levelIdx + step;
    if (next < 0 || next >= C.SIM_SPEED_LEVELS.length) return;
    this.levelIdx = next;
    this._sfx.warp();
    this._hud.hint(`時間加速 ×${this.simSpeed}`);
  }

  // 指定した simTime まで自動ワープする状態にする。
  startAutoWarpTo(time: number): void {
    this.autoWarpUntil = time;
  }

  // 自動ワープを解除する。
  cancelAutoWarp(): void {
    this.autoWarpUntil = null;
  }

  // 担当キーの受け口: [,]/[.] でワープ段を上下、[N] で直近ノードへの自動ワープをトグルする。
  // 計画編集中は WASDQE などと同じく [N] を計画側へ譲るため editMode 中は受け取らない。
  // ワープ操作は決着後・ポーズ中も効くべきなので、game はこれをそれらの early return より
  // 前に呼ぶ(自動ワープの段階調整そのものは update() が行う)。
  handleInput(input: Input, isPlaying: boolean, editMode: boolean, firstNode: OrbitState | undefined): void {
    if (input.takeKey(K.warpSlower)) this.shift(-1);
    if (input.takeKey(K.warpFaster)) this.shift(1);
    if (!editMode && input.takeKey(K.autoWarpToNode)) this.toggleAutoWarpToFirstNode(isPlaying, firstNode);
  }

  // 直近ノードの実行時刻までの自動ワープをトグルする。
  toggleAutoWarpToFirstNode(isPlaying: boolean, firstNode: OrbitState | undefined): void {
    // ノードがなければ計画を促す通知だけ出す
    if (!firstNode || !isPlaying) {
      this._hud.hint(`マニューバノードがありません ([${K.toggleMapMode.label}] で計画)`);
      return;
    }
    // 自動ワープ中なら解除、そうでなければノードの時刻まで開始する
    if (this.isAutoWarping) {
      this.cancelAutoWarp();
      this._hud.hint('自動ワープ解除');
    } else {
      this.startAutoWarpTo(firstNode.t);
      this._hud.hint('ノードへ自動ワープ開始');
    }
  }

  // 残り時間に応じてシミュレーション速度を自動的に段階調整し、
  // 実行の窓に入ったら等倍へ戻して解除する。
  update(simTime: number): void {
    if (this.autoWarpUntil === null) return;
    const tRem = this.autoWarpUntil - simTime;
    if (tRem <= C.NODE_APPROACH_LEAD) {
      this.autoWarpUntil = null;
      this.levelIdx = 0;
      // ここで return せずループへ落ちると、解除した直後の tRem からもう一度
      // 段を再計算してしまい、×1 に戻したばかりの levelIdx を同じフレームで
      // 上書きしてしまう。
      return;
    }
    let idx = 0;
    for (let i = 0; i < C.SIM_SPEED_LEVELS.length; i++) {
      if (C.SIM_SPEED_LEVELS[i]! <= tRem / C.AUTOWARP_MARGIN) idx = i;
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
    if (tRem <= C.AUTOWARP_STOP) return 0;
    let realSec = 0;
    for (let i = C.SIM_SPEED_LEVELS.length - 1; i >= 0; i--) {
      const s = C.SIM_SPEED_LEVELS[i]!;
      if (s > tRem / C.AUTOWARP_MARGIN) continue;
      const lowerBound = Math.max(C.AUTOWARP_STOP, s * C.AUTOWARP_MARGIN);
      if (tRem <= lowerBound) continue;
      realSec += (tRem - lowerBound) / s;
      tRem = lowerBound;
    }
    return realSec;
  }
}
