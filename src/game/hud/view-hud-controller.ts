// 戦闘/マップそれぞれの HUD パネル同期をまとめる。DOM ルートの表示切替は Hud が持ち、
// ここではアクティブなビューのパネルだけを毎フレーム更新する。
import type { Game } from '../game';
import type { Hud } from './hud';

export class CombatHudController {
  public constructor(private readonly hud: Hud) {}

  // 戦闘ビューの常設パネル一式を game の現在状態へ合わせる。
  public sync(game: Game): void {
    this.hud.syncBurnManagement(game.player?.boosterManagementViewModel() ?? null);
    this.hud.topBar.sync(game);
    this.hud.vesselPanel.sync(game);
    this.hud.orbitPanel.sync(game);
    this.hud.targetPanel.sync(game);
    this.hud.enemiesPanel.sync(game);
    this.hud.syncOrbitAnalysis(game);
  }
}

export class MapHudController {
  public constructor(private readonly hud: Hud) {}

  // マップビューの常設パネル一式を game の現在状態へ合わせる。
  public sync(game: Game): void {
    this.hud.syncBurnManagement(game.player?.boosterManagementViewModel() ?? null);
    this.hud.topBar.sync(game);
    this.hud.mapScaleBadge.sync(game);
    this.hud.orbitPanel.sync(game, false);
    this.hud.syncOrbitAnalysis(game);
  }
}
