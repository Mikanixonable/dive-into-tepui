// Stage 00: 無限耐久サバイバル。弾薬確保後、波状攻撃が自機破壊まで無限に続く。
import * as THREE from 'three/webgpu';
import * as C from '../const';
import { Stage, type StageDeps } from './stage';
import { KEY_MAPPING as K } from '../input/key-mapping';
import type { EntityManager } from '../simulation/entity-manager';
import type { Player } from '../player/player';
import type { Enemy } from '../game-entity/enemy';
import type { Hud } from '../hud/hud';
import type { Sfx } from '../../audio/sfx';
import type { EffectsSystem } from '../vfx/effects-system';
import { SimSpeedManager } from '../sim-speed-manager';
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { apsisAltitudes } from '../../physics/elements';
import { orbitalElementsOf, strongestAttractor } from '../../physics/attractor';
import type { Ephemeris } from '../../physics/ephemeris';
import { Vec3, add, addScaled, len, norm, randPerp, scale, sub, v3 } from '../../physics/vec3';
import { generateApproachingEnemy } from './spawner/enemy-generator';
import type { Stage00SaveData, StageSaveData } from '../save-data';

export class Stage00 extends Stage {
  static readonly id = '00' as const;
  static readonly selectLabel = 'stage 00';
  static readonly selectSub = '【無限耐久サバイバル】 常時選択可。弾薬を拾ってから始まる無限の波状攻撃。自機が破壊されるまで続く';
  static readonly selectKeys = ['Digit0'];

  private waveState: 'waiting_for_ammo' | 'spawning_enemies' | 'active_combat';
  private spawnTimer: number;
  private waveCount: number;

  // saved の型を StageSaveData に留めるのは stage.ts の StageClass 一覧に
  // 収める都合(具象ごとの拡張型では構築シグネチャが揃わない)。
  constructor(saved: StageSaveData | undefined, ...deps: StageDeps) {
    super(saved, ...deps);
    const s = saved as Stage00SaveData | undefined;
    this.waveState = s?.waveState ?? 'waiting_for_ammo';
    this.spawnTimer = s?.spawnTimer ?? 0;
    this.waveCount = s?.waveCount ?? 0;
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
  protected init(entities: EntityManager): void {
    const player = this.addPlayer();
    for (let i = 0; i < C.MAX_AMMO; i++) {
      this.logistics.spawnForPlayer(player, C.STAGE00_LOGISTICS_MIN_DIST, C.STAGE00_LOGISTICS_MAX_DIST);
    }
    // 初期状態でもランダムに敵を配置する
    this.spawnWave(player, (enemy) => this.addEnemy(enemy, entities), 'random');
  }

  // 敵の行動・補給の更新を行い、現在の waveState に応じたフェーズ処理へ分岐する。
  update(dt: number, player: Player | null, entities: EntityManager, simTime: number, simSpeed: SimSpeedManager): void {
    if (!this.isPlaying || !player) return;

    this.behaveAllEnemies(dt, player, entities, simTime, simSpeed);

    this.logistics.updateLogistics(simTime, player, simSpeed, true);

    if (this.waveState === 'waiting_for_ammo') return this.updateWaitingForAmmoPhase(player);
    if (this.waveState === 'spawning_enemies') return this.updateSpawningEnemiesPhase(dt, player, entities);
    if (this.waveState === 'active_combat') this.updateActiveCombatPhase(dt, player, entities, simTime);
  }

  checkWin(): boolean { return false; }
  onWin(): void { }

  // HUD に表示する現在のウェーブ数の文言を返す。
  hudSubStatus(): string {
    return `第${this.waveCount}波`;
  }

  // ウェーブ番号を進め、敵を生成して addEnemy 経由でエンティティ管理に登録する。
  private spawnWave(player: Player, addEnemy: (enemy: Enemy) => void, forcedPattern?: 'linear' | 'random'): void {
    const wave = ++this.waveCount;
    const enemies = generateWave(player.state, wave, this._ephemeris, this._hud, this._sfx, this._fx, this._scene, forcedPattern);
    for (const enemy of enemies) addEnemy(enemy);
  }

  // 自機が弾薬を確保するまで待ち、確保でき次第 spawning_enemies フェーズへ進める。
  private updateWaitingForAmmoPhase(player: Player): void {
    if (player.magsLeft <= 0 && player.roundsInMag <= 0) return;
    this.waveState = 'spawning_enemies';
    this.spawnTimer = C.STAGE00_SPAWN_DELAY;
    this._hud.toast('弾薬を確保した。敵部隊が接近中...', 3000);
  }

  // 遅延タイマーが尽きたら最初のウェーブを湧かせ、active_combat フェーズへ進める。
  private updateSpawningEnemiesPhase(dt: number, player: Player, entities: EntityManager): void {
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    this.spawnWave(player, (enemy) => this.addEnemy(enemy, entities));
    this.waveState = 'active_combat';
    this.spawnTimer = C.STAGE00_SPAWN_INTERVAL;
  }

  // 交戦圏外の敵を消し、同時展開数の上限内でタイマーに従い次のウェーブを湧かせる。
  private updateActiveCombatPhase(dt: number, player: Player, entities: EntityManager, simTime: number): void {
    despawnOutOfRangeEnemies(entities.enemies, player, C.STAGE00_MAX_RANGE, simTime, this);
    const activeGroups = countActiveWaveGroups(entities.enemies);
    const limits = resolveWaveSpawnLimits(this.waveCount, activeGroups);
    if (activeGroups === 0) {
      // 全滅または画面外へ離脱した場合でも、瞬時に次が湧き続ける無限ループを防ぐため最低2秒は待つ
      this.spawnTimer = Math.min(this.spawnTimer, 2.0);
    }
    if (activeGroups >= limits.maxGroups || this.waveCount >= limits.allowedMaxWaveCount) return;
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    this.spawnWave(player, (enemy) => this.addEnemy(enemy, entities));
    this.spawnTimer = C.STAGE00_SPAWN_INTERVAL;
    this._hud.toast(`波状攻撃 第${this.waveCount}波 接近中！`, 3000);
  }

  serialize(): Stage00SaveData {
    return {
      ...super.serialize(),
      waveState: this.waveState,
      spawnTimer: this.spawnTimer,
      waveCount: this.waveCount,
    };
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
  if (waveCount <= 1) return { maxGroups: 1, allowedMaxWaveCount: 2 };
  if (waveCount === 2) return activeGroups > 0 ? { maxGroups: 1, allowedMaxWaveCount: 2 } : { maxGroups: 2, allowedMaxWaveCount: 4 };
  if (waveCount === 3) return { maxGroups: 2, allowedMaxWaveCount: 4 };
  if (waveCount === 4) return activeGroups > 0 ? { maxGroups: 2, allowedMaxWaveCount: 4 } : { maxGroups: 3, allowedMaxWaveCount: Infinity };
  return { maxGroups: 3, allowedMaxWaveCount: Infinity };
}

// ウェーブ出現位置: 自機と同じ高度の水平方向(全方位)にランダムな距離で配置
function pickWaveCenter(player: KinematicState, wave: number): Vec3 {
  const dist = C.STAGE00_SPAWN_DIST_MIN + Math.random() * (C.STAGE00_SPAWN_DIST_MAX - C.STAGE00_SPAWN_DIST_MIN);

  // 第1波は必ず後方(速度ベクトルと逆向き)に出現させる。
  let dir: Vec3;
  if (wave === 1) {
    dir = norm(scale(player.v, -1));
  } else {
    dir = randPerp(norm(player.r));
  }

  return add(player.r, scale(dir, dist));
}

// ウェーブ中心が自機の近傍を通過するフライバイの接近方向と速度を求める。
function makeFlybyVelocity(player: KinematicState, centerR: Vec3, wave: number): { approachDir: Vec3; centerV: Vec3 } {
  const missDist = C.STAGE00_FLYBY_MISS_DIST_MIN + Math.random() * C.STAGE00_FLYBY_MISS_DIST_RANGE;
  const directDir = norm(sub(player.r, centerR));
  const missPerp = randPerp(directDir);
  const targetPos = add(player.r, scale(missPerp, missDist));

  const approachDir = norm(sub(targetPos, centerR));
  // ウェーブが進むほど接近速度を上げるが、上限を設けないと Δv が軌道を破壊する。
  const flybySpeed = Math.min(
    C.STAGE00_FLYBY_SPEED + (wave - 1) * C.STAGE00_FLYBY_SPEED_RAMP,
    C.STAGE00_FLYBY_SPEED_MAX,
  );
  const perpDir = randPerp(approachDir);
  const spread = scale(perpDir, Math.random() * C.STAGE00_FLYBY_LATERAL_SPREAD);
  return { approachDir, centerV: add(player.v, add(scale(approachDir, flybySpeed), spread)) };
}

// 近地点高度が REENTRY_ALT + STAGE00_MIN_PERIGEE_MARGIN を下回らないよう Δv の大きさを二分探索で縮める。
function limitFlybyDv(playerV: Vec3, centerR: Vec3, centerV: Vec3, t: number, ephemeris: Ephemeris): Vec3 {
  const minPeAlt = C.REENTRY_ALT + C.STAGE00_MIN_PERIGEE_MARGIN;
  const center = strongestAttractor(centerR, ephemeris.attractorsAt(t));
  // 与えた速度での近地点高度が最低ラインを満たすか判定する。
  const safe = (v: Vec3): boolean => {
    const el = orbitalElementsOf(kinematicState(t, centerR, v), center);
    return el !== null && apsisAltitudes(el).pe >= minPeAlt;
  };
  if (safe(centerV)) return centerV;

  // Δv の倍率を二分探索で縮め、安全な範囲に収める
  const dv = sub(centerV, playerV);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (safe(addScaled(playerV, dv, mid))) lo = mid;
    else hi = mid;
  }
  return addScaled(playerV, dv, lo);
}

// 基調色: アースカラー7割 / 寒色系2割 / アクセントカラー1割
function pickWaveBaseHex(): number {
  const randCol = Math.random();
  // アースカラー帯
  if (randCol < 0.7) {
    const earthColors = [0xc2b280, 0x808080, 0xb2beb5, 0x8b4513, 0xc3b091, 0x556b2f, 0x8f9779, 0x5f9ea0];
    return earthColors[Math.floor(Math.random() * earthColors.length)]!;
  }
  // 寒色系帯
  if (randCol < 0.9) {
    const coolColors = [0x722f37, 0x8a2be2, 0x0000ff, 0x00ffff, 0x40e0d0, 0x008000, 0x9acd32];
    return coolColors[Math.floor(Math.random() * coolColors.length)]!;
  }
  // アクセントカラー帯
  const accentColors = [0xffa500, 0xffc0cb, 0xff0000, 0xffffff];
  return accentColors[Math.floor(Math.random() * accentColors.length)]!;
}

// 基調色から HSL をずらした複数の準拠色(部隊内の識別カラー)を生成する。
function makeSubGroupHexes(baseHex: number): number[] {
  const baseColor = new THREE.Color(baseHex);
  const hsl = { h: 0, s: 0, l: 0 };
  baseColor.getHSL(hsl);

  const subGroupCount = 2 + Math.floor(Math.random() * 3);
  const subGroups: number[] = [];
  for (let i = 0; i < subGroupCount; i++) {
    // 色相/彩度/明度をそれぞれ小さくランダムに揺らす
    const hOffset = (Math.random() - 0.5) * 0.12;
    const sOffset = (Math.random() - 0.5) * 0.35;
    const lOffset = (Math.random() - 0.5) * 0.25;
    const subColor = new THREE.Color().setHSL(
      (hsl.h + hOffset + 1) % 1,
      Math.max(0, Math.min(1, hsl.s + sOffset)),
      Math.max(0.1, Math.min(0.9, hsl.l + lOffset))
    );
    subGroups.push(subColor.getHex());
  }
  return subGroups;
}

// ウェーブ中心を基準に、パターンに応じた個別の艦の初期位置を求める。
function waveShipPosition(pattern: 'linear' | 'random', i: number, shipCount: number, centerR: Vec3, approachDir: Vec3): Vec3 {
  let pos: Vec3;
  if (pattern === 'linear') {
    const offset = (i - (shipCount - 1) / 2) * C.STAGE00_FORMATION_SPACING;
    const jitter = scale(randPerp(approachDir), (Math.random() - 0.5) * 200);
    pos = add(centerR, add(scale(approachDir, -offset), jitter));
  } else {
    const randDir = norm(v3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5));
    const randDist = Math.random() * C.STAGE00_FORMATION_SPACING * (shipCount / 2);
    pos = add(centerR, scale(randDir, randDist));
  }

  const altDrop = C.STAGE00_ALT_OFFSET_MIN + Math.random() * (C.STAGE00_ALT_OFFSET_MAX - C.STAGE00_ALT_OFFSET_MIN);
  const droppedPos = add(pos, scale(norm(pos), altDrop));

  // 出現高度が大気圏上限(+10km)を下回らないようにクランプする。
  const safeAlt = C.REENTRY_ALT + 10e3;
  const currentAlt = len(droppedPos) - C.R_EARTH;
  if (currentAlt < safeAlt) {
    return scale(norm(droppedPos), C.R_EARTH + safeAlt);
  }
  return droppedPos;
}

// ウェーブ番号に応じた隻数・編成・接近軌道を決め、敵艦の配列を生成する。
export function generateWave(player: KinematicState, waveNumber: number, ephemeris: Ephemeris, hud: Hud, sfx: Sfx, fx: EffectsSystem, scene: THREE.Scene, forcedPattern?: 'linear' | 'random'): Enemy[] {
  const calculatedCount = C.STAGE00_WAVE_BASE_SHIPS + Math.floor((waveNumber - 1) * C.STAGE00_WAVE_SHIPS_PER_WAVE);
  const shipCount = Math.min(calculatedCount, C.STAGE00_WAVE_MAX_SHIPS);
  const centerR = pickWaveCenter(player, waveNumber);
  const { approachDir, centerV: rawCenterV } = makeFlybyVelocity(player, centerR, waveNumber);
  const centerV = limitFlybyDv(player.v, centerR, rawCenterV, player.t, ephemeris);
  const subGroups = makeSubGroupHexes(pickWaveBaseHex());
  const typeIndex = Math.floor(Math.random() * 3);
  const pattern = forcedPattern || (Math.random() < 0.5 ? 'linear' : 'random');

  // 隻数分、位置と識別カラーを割り当てて敵艦を生成する
  const enemies: Enemy[] = [];
  for (let i = 0; i < shipCount; i++) {
    const accent = subGroups[i % subGroups.length]!;
    const position = waveShipPosition(pattern, i, shipCount, centerR, approachDir);
    const state: KinematicState = kinematicState(player.t, position, centerV);
    enemies.push(generateApproachingEnemy(`W${waveNumber}-${i + 1}`, state, C.STAGE0_ENEMY_HP, accent, accent, typeIndex, waveNumber, hud, sfx, fx, scene));
  }
  return enemies;
}
