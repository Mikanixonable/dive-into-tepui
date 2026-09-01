// デバッグ用ステージ: 敵集団1つのみを配置し、勝敗を発生させずに検証を続けられる。
// 敵の射撃 ON/OFF をパネルから切り替えられる。タイトルの通常ボタン列には出ない。
import { Stage, type StageDeps, STORY_EPOCH } from './stage';
import { generateWave } from './stage-utils/wave-attack';
import { Button, ToggleSwitch } from '../hud/widgets';
import * as C from '../const';
import type { Player } from '../player/player';
import type { DynamicSystem } from '../dynamic/dynamic-system';
import { SimSpeedManager } from '../dynamic/sim-speed-manager';
import type { StageSaveData } from '../save/save-data';
import { MAG_ROUNDS } from '../player/player-fire';

export class StageDebug extends Stage {
  static readonly id = 'debug' as const;
  static readonly epoch = STORY_EPOCH;
  static readonly selectLabel = 'DEBUG';
  static readonly selectSub = '【デバッグ】敵集団1つ・撃破しても終了しない・敵の射撃を実行中に切替可能';
  static readonly hiddenFromSelect = true;
  static readonly selectKeys = ['KeyD'];

  private enemyFireEnabled = false;
  private fireToggle!: ToggleSwitch;
  private waveCount = 2; // ランダム方向からスポーンさせるため2から開始

  constructor(saved: StageSaveData | undefined, ...deps: StageDeps) {
    super(saved, ...deps);
    this.begin();
  }

  // デバッグステージのブリーフィング文言を返す。
  briefingHtml(): string {
    return `<b>デバッグステージ</b><br>敵集団 ${this.scoreCounter.totalEnemiesSpawned} 機。撃破しても終了しない。ステータスウィンドウ左部から敵の射撃を切替可能`;
  }

  // 自機を置き、敵集団を1つだけ生成し、射撃切替トグルをステータスウィンドウ左部へ追加する。
  protected init(entities: DynamicSystem): void {
    const player = this.addPlayer({ ammo: { mags: 20, rounds: MAG_ROUNDS } });
    const enemies = generateWave(player.state, this.waveCount++, this._celestialSystem, this._worldSfx, this._fx, this._scene, 'random');
    for (const enemy of enemies) this.addEnemy(enemy, entities);

    // 切替は enemyFireEnabled へ入るだけで、敵への反映は update が毎フレーム行う
    this.fireToggle = new ToggleSwitch('敵射撃', (on) => { this.enemyFireEnabled = on; });
    this.fireToggle.setOn(false); // デフォルトでオフ
    this.addStatusPanelWidget(this.fireToggle.element);

    // 敵集団をスポーンするボタン
    const spawnEnemyBtn = new Button('敵集団をスポーン', () => {
      const newEnemies = generateWave(player.state, this.waveCount++, this._celestialSystem, this._worldSfx, this._fx, this._scene, 'random');
      for (const enemy of newEnemies) this.addEnemy(enemy, entities);
    });
    this.addStatusPanelWidget(spawnEnemyBtn.element);

    // 弾薬をスポーンするボタン
    const spawnAmmoBtn = new Button('弾薬をスポーン', () => {
      this.logistics.spawnForPlayer(player, C.STAGE00_LOGISTICS_MIN_DIST, C.STAGE00_LOGISTICS_MAX_DIST);
    });
    this.addStatusPanelWidget(spawnAmmoBtn.element);

    // RCS燃料をスポーンするボタン
    const spawnFuelBtn = new Button('RCS燃料をスポーン', () => {
      this.logistics.spawnRcsFuelForPlayer(player, C.STAGE00_LOGISTICS_MIN_DIST, C.STAGE00_LOGISTICS_MAX_DIST);
    });
    this.addStatusPanelWidget(spawnFuelBtn.element);
  }

  // 敵の行動を進め、射撃許可を毎フレーム自ステージの敵全体へ反映する。
  update(_dt: number, player: Player | null, entities: DynamicSystem, simTime: number, simSpeed: SimSpeedManager): void {
    if (!player) return;
    for (const e of entities.enemies) e.fireEnabled = this.enemyFireEnabled;
    this.behaveAllEnemies(player, entities, simTime, simSpeed);
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
