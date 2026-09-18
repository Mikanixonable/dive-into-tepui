// Stage 00: 無限耐久サバイバル。弾薬確保後、波状攻撃が自機破壊まで無限に続く。
import { Stage, type SerializedStage, type StageDeps, STORY_EPOCH } from './stage';
import { KEY_MAPPING as K } from '../../input/key-mapping';
import { SimSpeedManager } from '../dynamic/sim-speed-manager';
import { isEnemy } from '../dynamic/dynamic-entity/enemy';
import { WaveAttack, type SerializedWaveAttack } from './stage-utils/wave-attack';
import { MAX_ACTIVE_AMMO_PICKUPS, LOGISTICS_SCRIPTED_MIN_DIST, LOGISTICS_SCRIPTED_MAX_DIST } from './stage-utils/logistics';

export interface SerializedStage00 extends SerializedStage, SerializedWaveAttack {
}

export class Stage00 extends Stage {
  static readonly id = '00' as const;
  static readonly epoch = STORY_EPOCH;
  static readonly selectLabel = 'stage 00';
  static readonly selectSub = '【無限耐久サバイバル】 常時選択可。弾薬を拾ってから始まる無限の波状攻撃。自機が破壊されるまで続く';
  static readonly selectKey = 'Digit0';

  private readonly waveAttack: WaveAttack;

  // 保存があれば波状攻撃の進行を引き継いで始める。
  constructor(saved: SerializedStage | undefined, ...deps: StageDeps) {
    super(saved, ...deps);
    this.waveAttack = new WaveAttack(
      this._dynamicSystem.events, this._scene, this._celestialSystem.celestialMotions,
      this._dynamicSystem.idAllocators, saved as SerializedStage00 | undefined,
    );
    this.begin();
  }

  // ミッション概要のブリーフィング文(HTML)を返す。
  briefingHtml(): string {
    return (
      '<b>サバイバル任務: 弾薬を回収し、無限の敵から生き残れ！</b><br>' +
      '敵は次々と波状攻撃を仕掛けてくる。<br>' +
      '補給マガジンが近くに浮いている — 弾切れ時は回収せよ<br>' +
      `[${K.help.label}] キーで操作方法を表示`
    );
  }

  // 自機・弾薬ピックアップ・初期の敵ウェーブを配置する。
  protected init(): void {
    const player = this.addPlayer();
    for (let i = 0; i < MAX_ACTIVE_AMMO_PICKUPS; i++) {
      this.logistics.spawnForPlayer(player, LOGISTICS_SCRIPTED_MIN_DIST, LOGISTICS_SCRIPTED_MAX_DIST);
    }
    this.waveAttack.spawnWave(player, (enemy) => this.addEnemy(enemy), 'random');
  }

  // 補給と波状攻撃の更新を行う。
  update(dt: number, simTime: number, simSpeed: SimSpeedManager): void {
    const player = this.ship;
    if (!player) return;

    this.logistics.updateLogistics(simTime, player, simSpeed, true);
    this.waveAttack.update(dt, player, this._dynamicSystem.all().filter(isEnemy), simTime, this, (enemy) => this.addEnemy(enemy));
  }

  checkWin(): boolean { return false; }
  onWin(): void { }

  // HUD に表示する現在のウェーブ数の文言を返す。
  hudSubStatus(): string {
    return `第${this.waveAttack.waveCount}波`;
  }

  serialize(): SerializedStage00 {
    return {
      ...super.serialize(),
      ...this.waveAttack.serialize(),
    };
  }
}
