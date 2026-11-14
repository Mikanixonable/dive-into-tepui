// Stage 00: 無限耐久サバイバル。弾薬確保後、波状攻撃が自機破壊まで無限に続く。
import { Stage, type CommonStageState, type RunOptions, type SerializedStage, type StageDeps, STORY_EPOCH } from './stage';
import { KEY_MAPPING as K } from '../../input/key-mapping';
import { isEnemy } from '../dynamic/dynamic-entity/enemy';
import { WaveAttack, waveForecastLine, type SerializedWaveAttack } from './stage-utils/wave-attack';
import {
  MAX_ACTIVE_AMMO_PICKUPS, LOGISTICS_SCRIPTED_MIN_DIST, LOGISTICS_SCRIPTED_MAX_DIST, phaseShiftedBy,
} from './stage-utils/logistics';
import { ModularShip } from '../ship/modular-ship';
import { createSalvageTenderPreset } from '../ship/ship-presets';
import type { SimSpeedManager } from '../dynamic/sim-speed-manager';
import { SURVIVAL_STAGE_RULES } from './stage-rules';

// 補給艇が現れる、自機の軌道上の前方の距離の範囲 [m](SPEC GAME.md 2.3)。
const TENDER_MIN_DIST = 300;
const TENDER_MAX_DIST = 500;

export interface SerializedStage00 extends SerializedStage {
  readonly waveAttack: SerializedWaveAttack;
}

export class Stage00 extends Stage {
  public static readonly id = '00' as const;
  public static readonly epoch = STORY_EPOCH;
  public static readonly selectLabel = 'stage 00';
  public static readonly selectSub = '【無限耐久サバイバル】 常時選択可。弾薬を拾ってから始まる無限の波状攻撃。自機が破壊されるまで続く';
  public static readonly selectKey = 'Digit0';
  public static readonly stageRules = SURVIVAL_STAGE_RULES;

  private readonly waveAttack: WaveAttack;
  // ブリーフィングに最初の波の予告を足すか(連敗のあとの周回)。
  private forecast = false;

  // 波状攻撃の進行と共通の状態から組む。省いた波状攻撃は新しい進行から始まる。
  private constructor(deps: StageDeps, waveAttack?: WaveAttack, ...common: CommonStageState) {
    super(deps, ...common);
    this.waveAttack = waveAttack ?? new WaveAttack(
      this._dynamicSystem.events, this._scene, this._celestialSystem.celestialMotions,
      this._dynamicSystem.idAllocators,
    );
  }

  // 自機・弾薬ピックアップ・初期の敵ウェーブを配置して始める。
  public static create(...deps: StageDeps): Stage00 {
    const stage = new Stage00(deps);
    const player = stage.addPlayer();
    for (let i = 0; i < MAX_ACTIVE_AMMO_PICKUPS; i++) {
      stage.logistics.spawnForPlayer(player, LOGISTICS_SCRIPTED_MIN_DIST, LOGISTICS_SCRIPTED_MAX_DIST);
    }
    stage.waveAttack.spawnWave(player, stage, 'random');
    stage.composeBriefing();
    return stage;
  }

  // 直列化した形から復元する。
  public static deserialize(serialized: SerializedStage00 | null, ...deps: StageDeps): Stage00 {
    const [, scene, dynamicSystem, celestialSystem] = deps;
    const waveAttack = serialized?.waveAttack;
    return new Stage00(
      deps,
      // null も欠けと同じく新しい進行から始める。
      waveAttack == null ? undefined : WaveAttack.deserialize(
        waveAttack, dynamicSystem.events, scene, celestialSystem.celestialMotions, dynamicSystem.idAllocators,
      ),
      ...Stage.deserializeCommonState(serialized, deps, Stage00.stageRules),
    );
  }

  // 連敗の予告を出す周回では、ブリーフィングへ最初の 3 波の予告を足す。周回を組んだ後に呼ぶ。
  public applyRunOptions(options: RunOptions): void {
    super.applyRunOptions(options);
    this.forecast = options.forecast;
    this.composeBriefing();
  }

  // ミッション概要のブリーフィング文(HTML)を返す。予告が要る周回では、操作の案内の直前に予告を挟む。
  protected briefingHtml(): string {
    const forecastHtml = this.forecast
      ? '<br><b>最初の 3 波の予告</b><br>' + [1, 2, 3].map(waveForecastLine).join('<br>') + '<br>'
      : '';
    // 任務・補給・予告・操作案内の順で本文を組む。
    return (
      '<b>サバイバル任務: 弾薬を回収し、無限の敵から生き残れ！</b><br>' +
      '敵は次々と波状攻撃を仕掛けてくる。<br>' +
      '補給マガジンが近くに浮いている — 弾切れ時は回収せよ<br>' +
      forecastHtml +
      `[${K.help.label}] キーで操作方法を表示`
    );
  }

  // 補給と波状攻撃を更新する。
  public update(dt: number, simTime: number, simSpeed: SimSpeedManager): void {
    const player = this.ship;
    if (!player) return;

    this.logistics.updateLogistics(simTime, player, simSpeed, true);
    this.waveAttack.update(dt, player, this._dynamicSystem.all().filter(isEnemy), simTime, this);
  }

  // 交戦中の集団が 0 になった波間に、積荷があれば補給艇を自機の前方へ届ける。届けたら true。
  public onLull(): boolean {
    const player = this.ship;
    if (player === null || this.salvageCargo.pending.length === 0) return false;
    // 同じ軌道の上へずらして置くので、自機との相対速度は小さく保たれ、ドッキングの速度条件を満たせる。
    const dist = TENDER_MIN_DIST + Math.random() * (TENDER_MAX_DIST - TENDER_MIN_DIST);
    const tender = ModularShip.create(
      {
        name: '補給艇',
        state: phaseShiftedBy(player.motion.state, dist),
        assembly: createSalvageTenderPreset(this.salvageCargo.takeAll()),
      },
      this._dynamicSystem,
      this._scene,
    );
    this._dynamicSystem.add(tender);
    this._dynamicSystem.events.record({ kind: 'salvageTenderArrived' });
    return true;
  }

  // 撃破数では決着させず、自機の喪失まで続ける。
  protected checkWin(): boolean { return false; }
  protected onWin(): void { }

  // HUD に表示する現在のウェーブ数の文言を返す。
  protected hudSubStatus(): string {
    return `第${this.waveAttack.waveCount}波`;
  }

  // 共通の内訳に、波状攻撃の進行を足して直列化する。
  public serialize(): SerializedStage00 {
    return {
      ...super.serialize(),
      waveAttack: this.waveAttack.serialize(),
    };
  }
}
