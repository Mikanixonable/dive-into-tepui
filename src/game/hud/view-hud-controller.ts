// 運用/マップそれぞれの HUD パネル同期をまとめる。DOM ルートの表示切替は Hud が持ち、
// ここではアクティブなビューのパネルだけを毎フレーム更新する。
import type { Attractor } from '../../physics/attractor';
import type { Game } from '../game';
import type { Hud } from './hud';

export class OperationsHudController {
  public constructor(private readonly hud: Hud) {}

  public sync(game: Game, attractors: readonly Attractor[]): void {
    this.hud.simulationStatusBar.sync(game);
    this.hud.vesselPanel.sync(game);
    this.hud.orbitPanel.sync(game, attractors);
    this.hud.targetPanel.sync(game, attractors);
    this.hud.enemiesPanel.sync(game);
  }
}

/** @deprecated Use OperationsHudController. Kept for internal save/build compatibility. */
export { OperationsHudController as CombatHudController };

export class MapHudController {
  public constructor(private readonly hud: Hud) {}

  public sync(game: Game): void {
    this.hud.mapScaleBadge.sync(game);
  }
}
