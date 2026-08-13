// Stage 00: 無限耐久サバイバル。弾薬確保後、波状攻撃が自機破壊まで無限に続く。
import * as C from '../const';
import { Stage, type StageDeps } from './stage';
import { KEY_MAPPING as K } from '../input/key-mapping';
import type { EntityManager } from '../simulation/entity-manager';
import type { Player } from '../player/player';
import type { Hud } from '../hud/hud';
import type { Sfx } from '../../audio/sfx';
import type { EffectsSystem } from '../vfx/effects-system';
import type { MarkerManager } from '../marker/marker-manager';
import type { Ephemeris } from '../../physics/ephemeris';
import type { Simulator } from '../simulation/simulator';
import type { UnlockManager } from '../unlock-manager';
import type * as THREE from 'three/webgpu';
import { SimSpeedManager } from '../sim-speed-manager';
import { WaveAttack } from './stage-utils/wave-attack';
import type { Stage00SaveData, StageSaveData } from '../save-data';

export class Stage00 extends Stage {
  static readonly id = '00' as const;
  static readonly selectLabel = 'stage 00';
  static readonly selectSub = '【無限耐久サバイバル】 常時選択可。弾薬を拾ってから始まる無限の波状攻撃。自機が破壊されるまで続く';
  static readonly selectKeys = ['Digit0'];
  readonly initialAmmo = { mags: C.INITIAL_MAGS - 1, rounds: C.MAG_ROUNDS };

  private waveAttack!: WaveAttack;
  // WaveAttack は hud/scene 等が setup() まで揃わないため生成できない。setup() まで控えておく。
  private readonly savedWaveAttack?: Stage00SaveData;

  // saved の型を StageSaveData に留めるのは stage.ts の StageClass 一覧に
  // 収める都合(具象ごとの拡張型では構築シグネチャが揃わない)。
<<<<<<< HEAD
  constructor(saved?: StageSaveData) {
    super(saved);
    this.savedWaveAttack = saved as Stage00SaveData | undefined;
  }

  setup(
    hud: Hud, sfx: Sfx, scene: THREE.Scene, entities: EntityManager, unlockManager: UnlockManager,
    fx: EffectsSystem, markerManager: MarkerManager, ephemeris: Ephemeris, simulator: Simulator,
  ): void {
    super.setup(hud, sfx, scene, entities, unlockManager, fx, markerManager, ephemeris, simulator);
    this.waveAttack = new WaveAttack(hud, sfx, fx, scene, ephemeris, this.savedWaveAttack);
=======
  constructor(saved: StageSaveData | undefined, ...deps: StageDeps) {
    super(saved, ...deps);
    const s = saved as Stage00SaveData | undefined;
    this.waveState = s?.waveState ?? 'waiting_for_ammo';
    this.spawnTimer = s?.spawnTimer ?? 0;
    this.waveCount = s?.waveCount ?? 0;
    this.begin();
>>>>>>> origin/workspace4
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

  // 弾薬ピックアップと初期の敵ウェーブを配置する。
  protected init(player: Player | null, entities: EntityManager): number {
    if (!player) return 0;
    for (let i = 0; i < C.MAX_AMMO; i++) {
      this.logistics.spawnForPlayer(player, C.STAGE00_LOGISTICS_MIN_DIST, C.STAGE00_LOGISTICS_MAX_DIST);
    }
    // 初期状態でもランダムに敵を配置する
    this.waveAttack.spawnWave(player, (enemy) => this.addEnemy(enemy, entities), 'random');
    return 0;
  }

  // 敵の行動・補給・波状攻撃の更新を行う。
  update(dt: number, player: Player | null, entities: EntityManager, simTime: number, simSpeed: SimSpeedManager): void {
    if (!this.isPlaying || !player) return;

    this.behaveAllEnemies(dt, player, entities, simTime, simSpeed);
    this.logistics.updateLogistics(simTime, player, simSpeed, true);
    this.waveAttack.update(dt, player, entities.enemies, simTime, this, (enemy) => this.addEnemy(enemy, entities));
  }

  checkWin(): boolean { return false; }
  onWin(): void { }

  // HUD に表示する現在のウェーブ数の文言を返す。
  hudSubStatus(): string {
    return `第${this.waveAttack.waveCount}波`;
  }

  serialize(): Stage00SaveData {
    return {
      ...super.serialize(),
      ...this.waveAttack.serialize(),
    };
  }
}
