// 戦闘/マップそれぞれの HUD パネル同期をまとめる。DOM ルートの表示切替は Hud が持ち、
// ここではアクティブなビューのパネルだけを毎フレーム更新する。
import type { Attractor } from '../../physics/attractor';
import type { Game } from '../game';
import type { Hud } from './hud';

export class CombatHudController {
  public constructor(private readonly hud: Hud) {}

  public sync(game: Game, attractors: readonly Attractor[]): void {
    this.hud.globalStatusBar.sync(game);
    this.hud.vesselPanel.sync(game);
    this.hud.orbitPanel.sync(game, attractors);
    this.hud.targetPanel.sync(game, attractors);
    this.hud.contactsPanel.sync(game);
  }
}

export class MapHudController {
  public constructor(private readonly hud: Hud) {}

  public sync(game: Game): void {
    this.hud.mapScaleBadge.sync(game);
  }
}
