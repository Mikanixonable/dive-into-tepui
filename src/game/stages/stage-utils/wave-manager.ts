// stage00(無限耐久サバイバル)の波状攻撃: フェーズ遷移・ウェーブ数・ウェーブ生成を管理する。
// Stage00 専用のヘルパーであり、Stage00 インスタンスが自身のフィールドとして直接保持する。
import * as THREE from 'three/webgpu';
import { len, sub } from '../../../physics/vec3';
import type { StageCtx } from '../stage';
import type { Logistics } from './logistics';
import { generateWave } from '../spawner/enemy-spawner';
import { Hud } from '../../../hud/hud';
import { Sfx } from '../../../audio/sfx';

export interface WaveEncounterConfig {
  spawnDelay: number; // 弾薬確保からウェーブ接近までの遅延
  spawnInterval: number; // ウェーブ間隔
  maxRange: number; // これより離れた敵は交戦圏外として消える
  respawnLogisticsOnDespawn: boolean; // 遠方デスポーンした補給を同数投入し直すか
}

export class WaveManager {
  phase: 'waiting_for_ammo' | 'spawning_enemies' | 'active_combat' = 'waiting_for_ammo';
  spawnTimer = 0;
  waveCount = 0;

  // Stage00 も静的シングルトンの一部として module 読み込み時に生成されるため、
  // WaveManager もコンストラクタ注入ができない — Stage.setup() と同じ理由・同じ
  // パターンで、Stage00.setup() から一度だけ呼ばれる。
  private _hud!: Hud;
  private _sfx!: Sfx;
  private _scene!: THREE.Scene;

  setup(hud: Hud, sfx: Sfx, scene: THREE.Scene): void {
    this._hud = hud;
    this._sfx = sfx;
    this._scene = scene;
  }

  // 1波分の敵を生成してステージに登録する(配置計算・Enemy 生成は enemy-spawner.ts の責務)。
  spawnWave(ctx: StageCtx, forcedPattern?: 'linear' | 'random'): void {
    const wave = ++this.waveCount;
    const enemies = generateWave(ctx.player.state, wave, this._hud, this._sfx, this._scene, forcedPattern);
    for (const enemy of enemies) ctx.addEnemy(enemy);
  }

  // 弾薬確保 → ウェーブ接近予告 → 波状攻撃、の3段階を直接遷移させる。数値設定は呼び出し側が渡す。
  update(dt: number, ctx: StageCtx, logistics: Logistics, config: WaveEncounterConfig): void {
    logistics.updateLogistics(ctx.simTime, ctx.player, config.respawnLogisticsOnDespawn);

    if (ctx.phase !== 'playing') return;
    if (this.phase === 'waiting_for_ammo') return this.updateWaitingForAmmoPhase(ctx, config.spawnDelay);
    if (this.phase === 'spawning_enemies') return this.updateSpawningEnemiesPhase(dt, ctx, config.spawnInterval);
    if (this.phase === 'active_combat') this.updateActiveCombatPhase(dt, ctx, config.maxRange, config.spawnInterval);
  }

  // 「弾薬確保待ち」フェーズ: 弾薬を入手したらウェーブ接近フェーズへ進める。
  private updateWaitingForAmmoPhase(ctx: StageCtx, spawnDelay: number): void {
    if (ctx.player.magsLeft <= 0 && ctx.player.roundsInMag <= 0) return;
    this.phase = 'spawning_enemies';
    this.spawnTimer = spawnDelay;
    this._hud.toast('弾薬を確保した。敵部隊が接近中...', 3000);
  }

  // 「ウェーブ接近予告」フェーズ: カウントダウン後に最初のウェーブを生成する。
  private updateSpawningEnemiesPhase(dt: number, ctx: StageCtx, spawnInterval: number): void {
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    this.spawnWave(ctx);
    this.phase = 'active_combat';
    this.spawnTimer = spawnInterval;
  }

  // 「交戦中」フェーズ: 圏外の敵を消しつつ、同時展開数の上限内で次のウェーブを送り込む。
  private updateActiveCombatPhase(dt: number, ctx: StageCtx, maxRange: number, spawnInterval: number): void {
    despawnOutOfRangeEnemies(ctx, maxRange);
    const activeGroups = countActiveWaveGroups(ctx);
    const limits = resolveWaveSpawnLimits(this.waveCount, activeGroups);
    if (activeGroups === 0) this.spawnTimer = 0;
    if (activeGroups >= limits.maxGroups || this.waveCount >= limits.allowedMaxWaveCount) return;
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    this.spawnWave(ctx);
    this.spawnTimer = spawnInterval;
    this._hud.toast(`波状攻撃 第${this.waveCount}波 接近中！`, 3000);
  }
}

// 自機から maxRange より離れた敵を交戦圏外として消す。
function despawnOutOfRangeEnemies(ctx: StageCtx, maxRange: number): void {
  for (const enemy of ctx.enemies) {
    if (!enemy.alive) continue;
    if (len(sub(enemy.state.r, ctx.player.state.r)) <= maxRange) continue;
    enemy.alive = false;
    enemy.dispose();
  }
}

// 生存中のウェーブ(waveId)がいくつ同時に交戦中かを数える。
function countActiveWaveGroups(ctx: StageCtx): number {
  const activeWaves = new Set<number>();
  for (const enemy of ctx.enemies) {
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
