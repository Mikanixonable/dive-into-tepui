// シミュレーション速度(HUD ヒント・SFX 上は「ワープ」と呼ぶ)の段階管理と、
// [N] キーによる「マニューバノードの実行時刻まで自動的に加速する」機能を担う。
// マップモードの計画データそのものには依存しない — どのノード時刻へ
// 自動ワープするかは呼び出し側(game.ts / PlanEditor)が決めて渡す。
import * as C from './const';
import { Hud } from './hud/hud';
import { Sfx } from '../audio/sfx';
import { OrbitState } from '../physics/orbital';

export class SimSpeedManager {
  private levelIdx = 0;
  private autoWarpUntil: number | null = null;

  constructor(
    private readonly _hud: Hud,
    private readonly _sfx: Sfx,
  ) {}

  get simSpeed(): number {
    return C.SIM_SPEED_LEVELS[this.levelIdx]!;
  }

  get isAutoWarping(): boolean {
    return this.autoWarpUntil !== null;
  }

  // 現在のワープ倍率で物理的な相互作用(推進・射撃・衝突・敵AI)が有効かどうか。
  // 呼び出し側は simSpeed そのものを受け取って閾値判定するのではなく、ここを見る。
  get canPlayerThrust(): boolean {
    return this.simSpeed <= C.MAX_PHYS_SIM_SPEED;
  }

  get canPlayerFire(): boolean {
    return this.simSpeed <= C.MAX_PHYS_SIM_SPEED;
  }

  get canEnemyFire(): boolean {
    return this.simSpeed <= C.MAX_PHYS_SIM_SPEED;
  }

  get canResolvePhysicalCollisions(): boolean {
    return this.simSpeed <= C.MAX_PHYS_SIM_SPEED;
  }

  shift(step: number): void {
    this.cancelAutoWarp();
    const next = this.levelIdx + step;
    if (next < 0 || next >= C.SIM_SPEED_LEVELS.length) return;
    this.levelIdx = next;
    this._sfx.warp();
    this._hud.hint(`TIME WARP ×${this.simSpeed}`);
  }

  startAutoWarpTo(time: number): void {
    this.autoWarpUntil = time;
  }

  cancelAutoWarp(): void {
    this.autoWarpUntil = null;
  }

  // [N] キー: 直近ノードの実行時刻までの自動ワープをトグルする(呼び出し側で
  // マップモード中でないことを確認してから呼ぶ)。
  toggleAutoWarpToFirstNode(isPlaying: boolean, firstNode: OrbitState | undefined): void {
    if (!firstNode || !isPlaying) {
      this._hud.hint('マニューバノードがありません ([M] で計画)');
      return;
    }
    if (this.isAutoWarping) {
      this.cancelAutoWarp();
      this._hud.hint('自動ワープ解除');
    } else {
      this.startAutoWarpTo(firstNode.t);
      this._hud.hint('ノードへ自動ワープ開始');
    }
  }

  // 残り時間に応じてシミュレーション速度を自動的に段階調整し、
  // AUTOWARP_STOP 秒前になったら解除する。
  update(simTime: number): void {
    if (this.autoWarpUntil === null) return;
    const tRem = this.autoWarpUntil - simTime;
    if (tRem <= C.AUTOWARP_STOP) {
      this.autoWarpUntil = null;
      this._hud.hint('マニューバ実行点に接近 — BURN ガイドの方向へ加速せよ', 5000);
      this.levelIdx = 0;
    }
    let idx = 0;
    for (let i = 0; i < C.SIM_SPEED_LEVELS.length; i++) {
      if (C.SIM_SPEED_LEVELS[i]! <= tRem / C.AUTOWARP_MARGIN) idx = i;
    }
    this.levelIdx = idx;
  }
}
