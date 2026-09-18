// デバッグ用ステージ: 敵集団1つのみを配置し、勝敗を発生させずに検証を続けられる。
// 敵の射撃 ON/OFF をパネルから切り替えられる。
import { Stage, type CommonStageState, type SerializedStage, type StageDeps, STORY_EPOCH } from './stage';
import { generateWave } from './stage-utils/wave-attack';
import { Button, ToggleSwitch } from '../../hud/widgets';
import { isEnemy, type Enemy } from '../dynamic/dynamic-entity/enemy';
import { MAG_ROUNDS } from '../player/ammo-spec';
import { LOGISTICS_SCRIPTED_MIN_DIST, LOGISTICS_SCRIPTED_MAX_DIST } from './stage-utils/logistics';
import { FREE_PLAY_STAGE_RULES } from './stage-rules';
import { stageDebugCommands, type StageDebugCommands } from './stage-debug-commands';
import type { SimSpeedManager } from '../dynamic/sim-speed-manager';
import type { Player } from '../player/player';

// デバッグステージの内訳。敵の射撃の可否と、次に出す敵集団の通し番号を持つ。
export interface SerializedStageDebug extends SerializedStage {
  readonly enemyFireEnabled: boolean;
  readonly waveCount: number;
}

export class StageDebug extends Stage {
  public static readonly id = 'debug' as const;
  public static readonly stageRules = FREE_PLAY_STAGE_RULES;
  public static readonly epoch = STORY_EPOCH;
  public static readonly selectLabel = 'DEBUG';
  public static readonly selectSub = '【デバッグ】敵集団1つ・撃破しても終了しない・敵の射撃を実行中に切替可能';
  public static readonly hiddenFromSelect = true;

  // パネルの操作を積む先。
  private readonly commands: StageDebugCommands;

  // 敵の射撃の可否・次に出す敵集団の通し番号と共通の状態から組み、射撃切替トグルとスポーンボタン列を
  // ステータスウィンドウ左部へ追加する。省いた値は新しいランの初期値から始まる。
  private constructor(
    deps: StageDeps,
    private enemyFireEnabled = false,
    // ランダム方向からスポーンさせるため2から開始
    private waveCount = 2,
    ...common: CommonStageState
  ) {
    super(deps, ...common);
    this.commands = stageDebugCommands(this._commandQueue, this);

    const fireToggle = new ToggleSwitch('敵射撃', (on) => this.commands.setEnemyFireEnabled(on));
    fireToggle.setOn(this.enemyFireEnabled);
    this.addStatusPanelWidget(fireToggle.element);

    // 以降は、検証を続けるための手動スポーン。
    const spawnEnemyBtn = new Button('敵集団をスポーン', () => this.commands.spawnEnemyWave());
    this.addStatusPanelWidget(spawnEnemyBtn.element);

    const spawnAmmoBtn = new Button('弾薬をスポーン', () => this.commands.spawnAmmo());
    this.addStatusPanelWidget(spawnAmmoBtn.element);

    const spawnFuelBtn = new Button('RCS燃料をスポーン', () => this.commands.spawnRcsFuel());
    this.addStatusPanelWidget(spawnFuelBtn.element);
  }

  // 自機と敵集団1つを置いて始める。
  public static create(...deps: StageDeps): StageDebug {
    const stage = new StageDebug(deps);
    const player = stage.addPlayer({ ammo: { mags: 20, rounds: MAG_ROUNDS } });
    for (const enemy of stage.generateWaveAround(player)) stage.addEnemy(enemy);
    stage.composeBriefing();
    return stage;
  }

  // 直列化した形から復元する。
  public static deserialize(serialized: SerializedStageDebug, ...deps: StageDeps): StageDebug {
    return new StageDebug(
      deps, serialized.enemyFireEnabled, serialized.waveCount,
      ...Stage.deserializeCommonState(serialized, deps, StageDebug.stageRules),
    );
  }

  // 共通の内訳に、敵の射撃の可否と敵集団の通し番号を足して直列化する。
  public override serialize(): SerializedStageDebug {
    return { ...super.serialize(), enemyFireEnabled: this.enemyFireEnabled, waveCount: this.waveCount };
  }

  // デバッグステージのブリーフィング文言を返す。
  protected briefingHtml(): string {
    return `<b>デバッグステージ</b><br>敵集団 ${this.enemiesAppeared} 機。撃破しても終了しない。ステータスウィンドウ左部から敵の射撃を切替可能`;
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
  public update(_dt: number, simTime: number, simSpeed: SimSpeedManager): void {
    const player = this.ship;
    if (!player) return;
    for (const e of this._dynamicSystem.all().filter(isEnemy)) e.fireEnabled = this.enemyFireEnabled;
    this.logistics.updateLogistics(simTime, player, simSpeed);
  }

  // 検証を継続できるよう、勝敗を発生させない。
  protected checkWin(): boolean {
    return false;
  }

  // 敵の射撃 ON/OFF の現在値を表示する。
  protected hudSubStatus(): string {
    return `敵射撃: ${this.enemyFireEnabled ? 'ON' : 'OFF'}`;
  }
}
