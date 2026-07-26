// stage00(無限耐久サバイバル)の波状攻撃: フェーズ遷移・ウェーブ数・ウェーブ生成を管理する。
// Stage00 専用のヘルパーであり、Stage00 インスタンスが自身のフィールドとして直接保持する。
import * as THREE from 'three/webgpu';
import { len, sub } from '../../../physics/vec3';
import type { Player } from '../../player/player';
import type { Enemy } from '../../orbit-entity/enemy';
import type { Logistics } from './logistics';
import { generateWave } from '../spawner/enemy-spawner';
import { Hud } from '../../hud/hud';
import { Sfx } from '../../../audio/sfx';
import type { EffectsSystem } from '../../vfx/effects-system';
import type { Stage } from '../stage';

export class WaveManager {
  phase: 'waiting_for_ammo' | 'spawning_enemies' | 'active_combat' = 'waiting_for_ammo';
  spawnTimer = 0;
  waveCount = 0;

  // Stage00 も静的シングルトンの一部として module 読み込み時に生成されるため、
  // hud/sfx/scene/fx はコンストラクタ注入ができない — Stage.setup() と同じ理由・同じ
  // パターンで、Stage00.setup() から一度だけ呼ばれる。
  private _hud!: Hud;
  private _sfx!: Sfx;
  private _scene!: THREE.Scene;
  private _fx!: EffectsSystem;

  constructor(
    private readonly spawnDelay: number, // 弾薬確保からウェーブ接近までの遅延
    private readonly spawnInterval: number, // ウェーブ間隔
    private readonly maxRange: number, // これより離れた敵は交戦圏外として消える
    private readonly respawnLogisticsOnDespawn: boolean, // 遠方デスポーンした補給を同数投入し直すか
  ) {}

  setup(hud: Hud, sfx: Sfx, scene: THREE.Scene, fx: EffectsSystem): void {
    this._hud = hud;
    this._sfx = sfx;
    this._scene = scene;
    this._fx = fx;
  }

  // 1波分の敵を生成してステージに登録する(配置計算・Enemy 生成は enemy-spawner.ts の責務)。
  spawnWave(player: Player, addEnemy: (enemy: Enemy) => void, forcedPattern?: 'linear' | 'random'): void {
    const wave = ++this.waveCount;
    const enemies = generateWave(player.state, wave, this._hud, this._sfx, this._fx, this._scene, forcedPattern);
    for (const enemy of enemies) addEnemy(enemy);
  }

  // 弾薬確保 → ウェーブ接近予告 → 波状攻撃、の3段階を直接遷移させる。
  update(
    dt: number,
    player: Player,
    enemies: readonly Enemy[],
    addEnemy: (enemy: Enemy) => void,
    simTime: number,
    logistics: Logistics,
    activeStage: Stage,
  ): void {
    logistics.updateLogistics(simTime, player, this.respawnLogisticsOnDespawn);

    if (this.phase === 'waiting_for_ammo') return this.updateWaitingForAmmoPhase(player);
    if (this.phase === 'spawning_enemies') return this.updateSpawningEnemiesPhase(dt, player, addEnemy);
    if (this.phase === 'active_combat') this.updateActiveCombatPhase(dt, enemies, player, addEnemy, simTime, activeStage);
  }

  // 「弾薬確保待ち」フェーズ: 弾薬を入手したらウェーブ接近フェーズへ進める。
  private updateWaitingForAmmoPhase(player: Player): void {
    if (player.magsLeft <= 0 && player.roundsInMag <= 0) return;
    this.phase = 'spawning_enemies';
    this.spawnTimer = this.spawnDelay;
    this._hud.toast('弾薬を確保した。敵部隊が接近中...', 3000);
  }

  // 「ウェーブ接近予告」フェーズ: カウントダウン後に最初のウェーブを生成する。
  private updateSpawningEnemiesPhase(dt: number, player: Player, addEnemy: (enemy: Enemy) => void): void {
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    this.spawnWave(player, addEnemy);
    this.phase = 'active_combat';
    this.spawnTimer = this.spawnInterval;
  }

  // 「交戦中」フェーズ: 圏外の敵を消しつつ、同時展開数の上限内で次のウェーブを送り込む。
  private updateActiveCombatPhase(dt: number, enemies: readonly Enemy[], player: Player, addEnemy: (enemy: Enemy) => void, simTime: number, activeStage: Stage): void {
    despawnOutOfRangeEnemies(enemies, player, this.maxRange, simTime, activeStage);
    const activeGroups = countActiveWaveGroups(enemies);
    const limits = resolveWaveSpawnLimits(this.waveCount, activeGroups);
    if (activeGroups === 0) {
      // 全滅または画面外へ離脱した場合でも、瞬時に次が湧き続ける無限ループを防ぐため最低2秒は待つ
      this.spawnTimer = Math.min(this.spawnTimer, 2.0);
    }
    if (activeGroups >= limits.maxGroups || this.waveCount >= limits.allowedMaxWaveCount) return;
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    this.spawnWave(player, addEnemy);
    this.spawnTimer = this.spawnInterval;
    this._hud.toast(`波状攻撃 第${this.waveCount}波 接近中！`, 3000);
  }
}

// 自機から maxRange より離れた敵を交戦圏外として消す。
function despawnOutOfRangeEnemies(enemies: readonly Enemy[], player: Player, maxRange: number, simTime: number, activeStage: Stage): void {
  for (const enemy of enemies) {
    if (!enemy.alive) continue;
    if (len(sub(enemy.state.r, player.state.r)) <= maxRange) continue;
    enemy.despawn(simTime, activeStage);
  }
}

// 生存中のウェーブ(waveId)がいくつ同時に交戦中かを数える。
function countActiveWaveGroups(enemies: readonly Enemy[]): number {
  const activeWaves = new Set<number>();
  for (const enemy of enemies) {
    if (enemy.alive && enemy.waveId !== undefined) activeWaves.add(enemy.waveId);
  }
  return activeWaves.size;
}

// ウェーブ数が進むほど同時展開数の上限を引き上げていく。
function resolveWaveSpawnLimits(waveCount: number, activeGroups: number): { maxGroups: number; allowedMaxWaveCount: number; } {

  switch (waveCount) {
    case 0: // waveCount は spawnWave() で 1 から始まるが、念のため 0 も同じ扱いにする
    case 1:
      return { maxGroups: 1, allowedMaxWaveCount: 2 };
    case 2:
      if (activeGroups > 0) return { maxGroups: 1, allowedMaxWaveCount: 2 };
      return { maxGroups: 2, allowedMaxWaveCount: 4 };
    case 3:
      return { maxGroups: 2, allowedMaxWaveCount: 4 };
    case 4:
      if (activeGroups > 0) return { maxGroups: 2, allowedMaxWaveCount: 4 };
      return { maxGroups: 3, allowedMaxWaveCount: Infinity };
    default:
      return { maxGroups: 3, allowedMaxWaveCount: Infinity };
  }
}
