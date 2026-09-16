// デバッグ用ステージ: 敵集団1つのみを配置し、勝敗を発生させずに検証を続けられる。
// 敵の射撃 ON/OFF をパネルから切り替えられる。
import { Stage, type StageDeps, STORY_EPOCH } from './stage';
import { generateWave } from './stage-utils/wave-attack';
import { Button, ToggleSwitch } from '../../hud/widgets';
import { SimSpeedManager } from '../dynamic/sim-speed-manager';
import { isEnemy, type Enemy } from '../dynamic/dynamic-entity/enemy';
import { MAG_ROUNDS } from '../player/ammo-spec';
import { LOGISTICS_SCRIPTED_MIN_DIST, LOGISTICS_SCRIPTED_MAX_DIST } from './stage-utils/logistics';
import { FREE_PLAY_STAGE_RULES } from './stage-rules';
import { stageDebugCommands, type StageDebugCommands } from './stage-debug-commands';
import type { StageSaveData } from '../save/save-data';
import type { Player } from '../player/player';

export class StageDebug extends Stage {
  static readonly id = 'debug' as const;
  static readonly stageRules = FREE_PLAY_STAGE_RULES;
  static readonly epoch = STORY_EPOCH;
  static readonly selectLabel = 'DEBUG';
  static readonly selectSub = '【デバッグ】敵集団1つ・撃破しても終了しない・敵の射撃を実行中に切替可能';
  static readonly hiddenFromSelect = true;

  private enemyFireEnabled = false;
  private waveCount = 2; // ランダム方向からスポーンさせるため2から開始
  // パネルの操作を積む先。
  private readonly commands: StageDebugCommands;

  constructor(saved: StageSaveData | undefined, ...deps: StageDeps) {
    super(saved, ...deps);
    this.commands = stageDebugCommands(this._commandQueue, this);
    this.begin();
  }

  // デバッグステージのブリーフィング文言を返す。
  briefingHtml(): string {
    return `<b>デバッグステージ</b><br>敵集団 ${this.scoreCounter.totalEnemiesSpawned} 機。撃破しても終了しない。ステータスウィンドウ左部から敵の射撃を切替可能`;
  }

  // 自機と敵集団1つを置き、射撃切替トグルとスポーンボタン列をステータスウィンドウ左部へ追加する。
  protected init(): void {
    const player = this.addPlayer({ ammo: { mags: 20, rounds: MAG_ROUNDS } });
    for (const enemy of this.generateWaveAround(player)) this.addEnemy(enemy);

    const fireToggle = new ToggleSwitch('敵射撃', (on) => this.commands.setEnemyFireEnabled(on));
    fireToggle.setOn(false);
    this.addStatusPanelWidget(fireToggle.element);

    // 以降は、検証を続けるための手動スポーン。
    const spawnEnemyBtn = new Button('敵集団をスポーン', () => this.commands.spawnEnemyWave());
    this.addStatusPanelWidget(spawnEnemyBtn.element);

    const spawnAmmoBtn = new Button('弾薬をスポーン', () => this.commands.spawnAmmo());
    this.addStatusPanelWidget(spawnAmmoBtn.element);

    const spawnFuelBtn = new Button('RCS燃料をスポーン', () => this.commands.spawnRcsFuel());
    this.addStatusPanelWidget(spawnFuelBtn.element);
  }

  // 敵の射撃の可否を切り替える。
  public setEnemyFireEnabled(on: boolean): void {
    this.enemyFireEnabled = on;
  }

  // 敵集団を1つ、自艦のまわりへ出す。自艦がいなければ何も出さない。
  public spawnEnemyWave(): void {
    const player = this.ship;
    if (player === null) return;
    for (const enemy of this.generateWaveAround(player)) this.addEnemy(enemy);
  }

  // 弾薬を1つ、自艦の近くへ出す。自艦がいなければ何も出さない。
  public spawnAmmo(): void {
    const player = this.ship;
    if (player === null) return;
    this.logistics.spawnForPlayer(player, LOGISTICS_SCRIPTED_MIN_DIST, LOGISTICS_SCRIPTED_MAX_DIST);
  }

  // RCS燃料を1つ、自艦の近くへ出す。自艦がいなければ何も出さない。
  public spawnRcsFuel(): void {
    const player = this.ship;
    if (player === null) return;
    this.logistics.spawnRcsFuelForPlayer(player, LOGISTICS_SCRIPTED_MIN_DIST, LOGISTICS_SCRIPTED_MAX_DIST);
  }

  // player のまわりへ出す敵集団を、ランダム方向で1波ぶん組む。
  private generateWaveAround(player: Player): readonly Enemy[] {
    return generateWave(
      player.motion.state, this.waveCount++, this._celestialSystem.celestialMotions,
      this._scene, this._dynamicSystem.idAllocators, 'random',
    );
  }

  // 射撃許可を毎フレーム自ステージの敵全体へ反映し、補給を進める。
  update(_dt: number, simTime: number, simSpeed: SimSpeedManager): void {
    const player = this.ship;
    if (!player) return;
    for (const e of this._dynamicSystem.all().filter(isEnemy)) e.fireEnabled = this.enemyFireEnabled;
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
