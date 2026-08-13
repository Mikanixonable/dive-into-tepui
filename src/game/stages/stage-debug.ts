// デバッグ用ステージ: 敵集団1つのみを配置し、勝敗を発生させずに検証を続けられる。
// 敵の射撃 ON/OFF をパネルから切り替えられる。タイトルの通常ボタン列には出ない。
import { Stage } from './stage';
import { generateWave } from './stage00';
import { hudButton, HudToggle } from '../hud/buttons';
import * as C from '../const';
import type { Player } from '../player/player';
import type { EntityManager } from '../simulation/entity-manager';
import { SimSpeedManager } from '../sim-speed-manager';
import { Asteroid } from '../game-entity/asteroid';
import { kinematicState } from '../../physics/kinematic-state';
import { add, v3 } from '../../physics/vec3';

export class StageDebug extends Stage {
  static readonly id = 'debug' as const;
  readonly selectLabel = 'DEBUG';
  readonly selectSub = '【デバッグ】敵集団1つ・撃破しても終了しない・敵の射撃を実行中に切替可能';
  readonly hiddenFromSelect = true;
  readonly selectKeys = ['KeyD'];
  readonly initialAmmo = { mags: 20, rounds: C.MAG_ROUNDS };

  private enemyFireEnabled = false;
  private fireToggle!: HudToggle;
  private waveCount = 2; // ランダム方向からスポーンさせるため2から開始

  // デバッグステージのブリーフィング文言を返す。
  briefingHtml(enemyCount: number): string {
    return `<b>デバッグステージ</b><br>敵集団 ${enemyCount} 機。撃破しても終了しない。ステータスウィンドウ左部から敵の射撃を切替可能`;
  }

  // 敵集団を1つだけ生成し、射撃切替トグルをステータスウィンドウ左部へ追加する。
  init(player: Player | null, entities: EntityManager): number {
    if (!player) return 0;
    const enemies = generateWave(player.state, this.waveCount++, this._ephemeris, this._hud, this._sfx, this._fx, this._scene, 'random');
    for (const enemy of enemies) this.addEnemy(enemy, entities);

    // 切替は enemyFireEnabled へ入るだけで、敵への反映は update が毎フレーム行う
    this.fireToggle = new HudToggle('敵射撃', (on) => { this.enemyFireEnabled = on; });
    this.fireToggle.setOn(false); // デフォルトでオフ
    this.addStatusPanelWidget(this.fireToggle.element);

    // 敵集団をスポーンするボタン
    const spawnEnemyBtn = hudButton('敵集団をスポーン', () => {
      const newEnemies = generateWave(player.state, this.waveCount++, this._ephemeris, this._hud, this._sfx, this._fx, this._scene, 'random');
      for (const enemy of newEnemies) this.addEnemy(enemy, entities);
    });
    this.addStatusPanelWidget(spawnEnemyBtn);

    // 弾薬をスポーンするボタン
    const spawnAmmoBtn = hudButton('弾薬をスポーン', () => {
      this.logistics.spawnForPlayer(player, C.STAGE00_LOGISTICS_MIN_DIST, C.STAGE00_LOGISTICS_MAX_DIST);
    });
    this.addStatusPanelWidget(spawnAmmoBtn);

    // 重力配線前の Asteroid の目視確認用: 自機付近に3体、離した位置へ配置する。
    const asteroidOffsets = [v3(2000, 0, 0), v3(0, 2000, 0), v3(0, 0, 2000)];
    for (const offset of asteroidOffsets) {
      const state = kinematicState(player.state.t, add(player.state.r, offset), player.state.v);
      entities.addAsteroid(new Asteroid(state, C.ASTEROID_TEST_MASS, C.ASTEROID_TEST_RADIUS, this._scene));
    }

    return enemies.length;
  }

  // 敵の行動を進め、射撃許可を毎フレーム自ステージの敵全体へ反映する。
  update(dt: number, player: Player | null, entities: EntityManager, simTime: number, simSpeed: SimSpeedManager): void {
    if (!this.isPlaying || !player) return;
    for (const e of entities.enemies) e.fireEnabled = this.enemyFireEnabled;
    this.behaveAllEnemies(dt, player, entities, simTime, simSpeed);
    this.logistics.updateLogistics(simTime, player, simSpeed);
  }

  // 検証を継続できるよう、勝敗を発生させない。
  checkWin(): boolean {
    return false;
  }

  // 敵の射撃 ON/OFF の現在値を表示する。
  hudSubStatus(): string {
    return `敵射撃: ${this.enemyFireEnabled ? 'ON' : 'OFF'}`;
  }
}
