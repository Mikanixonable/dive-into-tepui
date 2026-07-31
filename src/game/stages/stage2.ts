// Stage 2: 第二ステージ(モルニヤ戦域)。ステージ1クリアで解放(isUnlocked override)。
// checkWin/onWin/hudSubStatus は基底クラスの既定(撃破数で勝利・HUD補助表示なし)のまま使う。
import * as C from '../const';
import { Stage } from './stage';
import { KEY_MAPPING as K } from '../input/key-mapping';
import type { ClearCounts } from '../unlock-manager';
import {
  generateCoellipticEnemy,
  generateMolniyaEnemy,
  generatePhasedEnemy,
} from './spawner/enemy-generator';
import type { Player } from '../player/player';
import type { EntityManager } from '../simulation/entity-manager';
import { SimSpeedManager } from '../sim-speed-manager';

export class Stage2 extends Stage {
  static readonly id = '2' as const;
  readonly selectLabel = '[2] 第二ステージ — モルニヤ戦域';
  readonly selectSub = `敵は高楕円(モルニヤ級)軌道にも分布。軌道計画モード [${K.toggleMapMode.label}] での遷移が必須`;
  readonly selectLockedSub = '🔒 第一ステージをクリアすると解放';
  readonly selectKeys = ['Digit2'];
  readonly initialAmmo = { mags: C.INITIAL_MAGS - 1, rounds: C.MAG_ROUNDS };

  isUnlocked(clearCounts: ClearCounts): boolean {
    return (clearCounts['1'] ?? 0) > 0;
  }

  briefingHtml(enemyCount: number): string {
    return (
      `<b>作戦目標: 敵機 ${enemyCount} 機を全機撃破せよ</b><br>` +
      `敵の一部はモルニヤ級の高楕円軌道上にいる — [${K.toggleMapMode.label}] 軌道計画モードで遷移を計画せよ<br>` +
      `[${K.help.label}] キーで操作方法を表示`
    );
  }

  init(player: Player, entities: EntityManager): number {
    const base = player.state;
    const hud = this._hud;
    const sfx = this._sfx;
    const fx = this._fx;
    const scene = this._scene;
    this.addEnemy(generatePhasedEnemy('HOSTILE-α', base, 1800, 2, 0xff4a3d, C.ENEMY_ORBIT_LINE_COLOR, hud, sfx, fx, scene), entities);
    this.addEnemy(generateCoellipticEnemy('HOSTILE-β', base, -2600, 3000, 2, 0xff7a2d, C.ENEMY_ORBIT_LINE_COLOR, hud, sfx, fx, scene), entities);
    this.addEnemy(generateMolniyaEnemy('MOLNIYA-γ', base.t, 0.4, 2.6, 3, 0xe0409f, C.ENEMY_ORBIT_LINE_COLOR, hud, sfx, fx, scene), entities);
    this.addEnemy(generateMolniyaEnemy('MOLNIYA-δ', base.t, 2.5, 0.9, 3, 0xbf3dff, C.ENEMY_ORBIT_LINE_COLOR, hud, sfx, fx, scene), entities);
    this.addEnemy(generateMolniyaEnemy('MOLNIYA-ε', base.t, 4.6, 3.8, 3, 0xff2d6b, C.ENEMY_ORBIT_LINE_COLOR, hud, sfx, fx, scene), entities);
    return 5;
  }
  update(dt: number, player: Player, entities: EntityManager, simTime: number, simSpeed: SimSpeedManager): void {
    if (!this.isPlaying) return;

    this.behaveAllEnemies(dt, player, entities, simTime, simSpeed);

    this.logistics.updateLogistics(simTime, player);
  }
}
