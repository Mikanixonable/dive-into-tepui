// シミュレーション速度(旧「ワープ」)の段階管理と、[N] キーによる
// 「マニューバノードの実行時刻まで自動的に加速する」機能を担う。
// マップモード(map-mode/)の計画データそのものには依存しない — どのノード時刻へ
// 自動ワープするかは呼び出し側(game.ts / MapModeSystem)が決めて渡す。
import * as C from './const';
import { Hud } from '../hud/hud';
import { Sfx } from '../audio/sfx';

export class SimSpeedManager {
  private levelIdx = 0;
  private autoWarpUntil: number | null = null;

  constructor(
    private readonly hud: Hud,
    private readonly sfx: Sfx,
  ) {}

  get simSpeed(): number {
    return C.SIM_SPEED_LEVELS[this.levelIdx]!;
  }

  get isAutoWarping(): boolean {
    return this.autoWarpUntil !== null;
  }

  shift(step: number): void {
    this.cancelAutoWarp();
    const next = this.levelIdx + step;
    if (next < 0 || next >= C.SIM_SPEED_LEVELS.length) return;
    this.levelIdx = next;
    this.sfx.warp();
    this.hud.hint(`TIME WARP ×${this.simSpeed}`);
  }

  startAutoWarpTo(time: number): void {
    this.autoWarpUntil = time;
  }

  cancelAutoWarp(): void {
    this.autoWarpUntil = null;
  }

  // 残り時間に応じてシミュレーション速度を自動的に段階調整し、
  // AUTOWARP_STOP 秒前になったら解除する。
  update(simTime: number): void {
    if (this.autoWarpUntil === null) return;
    const tRem = this.autoWarpUntil - simTime;
    if (tRem <= C.AUTOWARP_STOP) {
      this.autoWarpUntil = null;
      this.hud.hint('マニューバ実行点に接近 — BURN ガイドの方向へ加速せよ', 5000);
      this.levelIdx = 0;
    }
    let idx = 0;
    for (let i = 0; i < C.SIM_SPEED_LEVELS.length; i++) {
      if (C.SIM_SPEED_LEVELS[i]! <= tRem / C.AUTOWARP_MARGIN) idx = i;
    }
    this.levelIdx = idx;
  }
}
