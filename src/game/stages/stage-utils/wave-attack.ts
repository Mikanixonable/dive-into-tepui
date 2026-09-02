// 波状攻撃: 弾薬確保待ち(waiting_for_ammo)→ 遅延後の初回湧き(spawning_enemies)→
// 交戦圏内数に応じた周期湧き(active_combat)の3フェーズを進めるフェーズ機械と、
// ウェーブ1回分の隻数・編成・接近軌道の生成。
import * as THREE from 'three/webgpu';
import { Enemy, STAGE00_MAX_RANGE } from '../../dynamic/dynamic-entity/enemy';
import { Player } from '../../player/player';
import type { Stage } from '../stage';
import type { Hud } from '../../hud/hud';
import type { WorldSfx } from '../../../audio/sfx/world-sfx';
import type { EffectsSystem } from '../../vfx/effects-system';
import type { CelestialSystem } from '../../celestial/celestial-system';
import { KinematicState, kinematicState } from '../../../physics/kinematic-state';
import { apsisAltitudes } from '../../../physics/elements';
import { R_EARTH } from '../../celestial/solar-system/constants';
import { strongestAttractor } from '../../../physics/attractor';
import { orbitalElementsOf } from '../../../physics/elements';
import { Vec3, add, addScaled, len, norm, randPerp, scale, sub, v3 } from '../../../math/vec3';
import { generateApproachingEnemy } from '../spawner/enemy-generator';

const REENTRY_ALT = 80e3; // 敵の軌道の近地点余裕を測る基準高度 [m](wave-attack.ts)

const STAGE00_SPAWN_DELAY = 10; // 弾取得からスポーンまでの遅延 [s]
const STAGE00_FORMATION_SPACING = 200; // 編隊の機体間隔 [m]
const STAGE00_ALT_OFFSET_MIN = -1000; // 自機よりどれくらい低くするか [m]
const STAGE00_ALT_OFFSET_MAX = -200;
const STAGE00_SPAWN_INTERVAL = 30.0; // 波状攻撃の間隔 [s]
const STAGE00_SPAWN_DIST_MIN = 10000; // 敵集団のスポーン距離
const STAGE00_SPAWN_DIST_MAX = 14000;
const STAGE00_FLYBY_SPEED = 200.0; // フライパスの相対速度 [m/s]
const STAGE00_WAVE_BASE_SHIPS = 5; // 第1波の機数
const STAGE00_WAVE_SHIPS_PER_WAVE = 2; // 波が進むごとに増える機数
const STAGE00_WAVE_MAX_SHIPS = 30; // 1ウェーブの最大機数上限
const STAGE00_FLYBY_MISS_DIST_MIN = 1000; // フライパスのすれ違い距離下限 [m]
const STAGE00_FLYBY_MISS_DIST_RANGE = 1000; // 同、上限までの幅 [m]
const STAGE00_FLYBY_SPEED_RAMP = 10; // 波が進むごとのフライパス速度増加 [m/s]

// フライパス速度の上限 [m/s]。ステージ00は無限に続き波数に上限がないため、これが無いと
// 相対速度が際限なく上がり、フライパスの Δv だけで敵の軌道が壊れる(近地点が地中に落ちる)。
// 400 m/s なら 30km の交戦圏を約75秒で通過する — 演出として十分速く、軌道も壊れない。
const STAGE00_FLYBY_SPEED_MAX = 400.0;

// 敵の軌道が保つべき近地点高度の余裕 [m](大気圏突入高度 REENTRY_ALT に加算する)。
// スポーン時の Δv はこの高度を割らない範囲まで縮められる(stage00.ts の limitFlybyDv)。
const STAGE00_MIN_PERIGEE_MARGIN = 40e3;
const STAGE00_FLYBY_LATERAL_SPREAD = 20; // フライパス初速の横ブレ最大 [m/s]

type WaveState = 'waiting_for_ammo' | 'spawning_enemies' | 'active_combat';

export interface WaveAttackSaveData {
  waveState: WaveState;
  spawnTimer: number;
  waveCount: number;
}

export class WaveAttack {
  private waveState: WaveState;
  private spawnTimer: number;
  private _waveCount: number;

  public get waveCount(): number { return this._waveCount; }

  // saved があればその状態(フェーズ・タイマー・ウェーブ数)から始める。
  public constructor(
    private readonly hud: Hud,
    private readonly worldSfx: WorldSfx,
    private readonly fx: EffectsSystem,
    private readonly scene: THREE.Scene,
    private readonly celestialSystem: CelestialSystem,
    saved?: WaveAttackSaveData,
  ) {
    this.waveState = saved?.waveState ?? 'waiting_for_ammo';
    this.spawnTimer = saved?.spawnTimer ?? 0;
    this._waveCount = saved?.waveCount ?? 0;
  }

  // ウェーブ番号を進め、敵を生成して addEnemy 経由でエンティティ管理に登録する。
  public spawnWave(player: Player, addEnemy: (enemy: Enemy) => void, forcedPattern?: 'linear' | 'random'): void {
    const wave = ++this._waveCount;
    const enemies = generateWave(player.state, wave, this.celestialSystem, this.worldSfx, this.fx, this.scene, forcedPattern);
    for (const enemy of enemies) addEnemy(enemy);
  }

  // フェーズ機械を1フレーム分進める。
  public update(
    dt: number, player: Player, enemies: readonly Enemy[], simTime: number,
    activeStage: Stage, addEnemy: (enemy: Enemy) => void,
  ): void {
    if (this.waveState === 'waiting_for_ammo') return this.updateWaitingForAmmoPhase(player);
    if (this.waveState === 'spawning_enemies') return this.updateSpawningEnemiesPhase(dt, player, addEnemy);
    if (this.waveState === 'active_combat') this.updateActiveCombatPhase(dt, player, enemies, simTime, activeStage, addEnemy);
  }

  // 自機が弾薬を確保するまで待ち、確保でき次第 spawning_enemies フェーズへ進める。
  private updateWaitingForAmmoPhase(player: Player): void {
    if (player.magsLeft <= 0 && player.roundsInMag <= 0) return;
    this.waveState = 'spawning_enemies';
    this.spawnTimer = STAGE00_SPAWN_DELAY;
    this.hud.toast('弾薬を確保した。敵部隊が接近中...', 3000);
  }

  // 遅延タイマーが尽きたら最初のウェーブを湧かせ、active_combat フェーズへ進める。
  private updateSpawningEnemiesPhase(dt: number, player: Player, addEnemy: (enemy: Enemy) => void): void {
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    this.spawnWave(player, addEnemy);
    this.waveState = 'active_combat';
    this.spawnTimer = STAGE00_SPAWN_INTERVAL;
  }

  // 交戦圏外の敵を消し、同時展開数の上限内でタイマーに従い次のウェーブを湧かせる。
  private updateActiveCombatPhase(
    dt: number, player: Player, enemies: readonly Enemy[], simTime: number,
    activeStage: Stage, addEnemy: (enemy: Enemy) => void,
  ): void {
    despawnOutOfRangeEnemies(enemies, player, STAGE00_MAX_RANGE, simTime, activeStage);
    const activeGroups = countActiveWaveGroups(enemies);
    const limits = resolveWaveSpawnLimits(this._waveCount, activeGroups);
    if (activeGroups === 0) {
      // 全滅または画面外へ離脱した場合でも、瞬時に次が湧き続ける無限ループを防ぐため最低2秒は待つ
      this.spawnTimer = Math.min(this.spawnTimer, 2.0);
    }
    if (activeGroups >= limits.maxGroups || this._waveCount >= limits.allowedMaxWaveCount) return;
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    this.spawnWave(player, addEnemy);
    this.spawnTimer = STAGE00_SPAWN_INTERVAL;
    this.hud.toast(`波状攻撃 第${this._waveCount}波 接近中！`, 3000);
  }

  public serialize(): WaveAttackSaveData {
    return { waveState: this.waveState, spawnTimer: this.spawnTimer, waveCount: this._waveCount };
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
  const dist = STAGE00_SPAWN_DIST_MIN + Math.random() * (STAGE00_SPAWN_DIST_MAX - STAGE00_SPAWN_DIST_MIN);

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
  const missDist = STAGE00_FLYBY_MISS_DIST_MIN + Math.random() * STAGE00_FLYBY_MISS_DIST_RANGE;
  const directDir = norm(sub(player.r, centerR));
  const missPerp = randPerp(directDir);
  const targetPos = add(player.r, scale(missPerp, missDist));

  const approachDir = norm(sub(targetPos, centerR));
  // ウェーブが進むほど接近速度を上げるが、上限を設けないと Δv が軌道を破壊する。
  const flybySpeed = Math.min(
    STAGE00_FLYBY_SPEED + (wave - 1) * STAGE00_FLYBY_SPEED_RAMP,
    STAGE00_FLYBY_SPEED_MAX,
  );
  const perpDir = randPerp(approachDir);
  const spread = scale(perpDir, Math.random() * STAGE00_FLYBY_LATERAL_SPREAD);
  return { approachDir, centerV: add(player.v, add(scale(approachDir, flybySpeed), spread)) };
}

// 近地点高度が REENTRY_ALT + STAGE00_MIN_PERIGEE_MARGIN を下回らないよう Δv の大きさを二分探索で縮める。
function limitFlybyDv(playerV: Vec3, centerR: Vec3, centerV: Vec3, t: number, celestialSystem: CelestialSystem): Vec3 {
  const minPeAlt = REENTRY_ALT + STAGE00_MIN_PERIGEE_MARGIN;
  const center = strongestAttractor(centerR, celestialSystem.celestialMotions, t);
  // 与えた速度での近地点高度が最低ラインを満たすか判定する。
  const safe = (v: Vec3): boolean => {
    const el = orbitalElementsOf(kinematicState<'eci'>(t, centerR, v), center, t);
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
    const offset = (i - (shipCount - 1) / 2) * STAGE00_FORMATION_SPACING;
    const jitter = scale(randPerp(approachDir), (Math.random() - 0.5) * 200);
    pos = add(centerR, add(scale(approachDir, -offset), jitter));
  } else {
    const randDir = norm(v3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5));
    const randDist = Math.random() * STAGE00_FORMATION_SPACING * (shipCount / 2);
    pos = add(centerR, scale(randDir, randDist));
  }

  const altDrop = STAGE00_ALT_OFFSET_MIN + Math.random() * (STAGE00_ALT_OFFSET_MAX - STAGE00_ALT_OFFSET_MIN);
  const droppedPos = add(pos, scale(norm(pos), altDrop));

  // 出現高度が大気圏上限(+10km)を下回らないようにクランプする。
  const safeAlt = REENTRY_ALT + 10e3;
  const currentAlt = len(droppedPos) - R_EARTH;
  if (currentAlt < safeAlt) {
    return scale(norm(droppedPos), R_EARTH + safeAlt);
  }
  return droppedPos;
}

// ウェーブ番号に応じた隻数・編成・接近軌道を決め、敵艦の配列を生成する。
export function generateWave(player: KinematicState, waveNumber: number, celestialSystem: CelestialSystem, worldSfx: WorldSfx, fx: EffectsSystem, scene: THREE.Scene, forcedPattern?: 'linear' | 'random'): Enemy[] {
  const calculatedCount = STAGE00_WAVE_BASE_SHIPS + Math.floor((waveNumber - 1) * STAGE00_WAVE_SHIPS_PER_WAVE);
  const shipCount = Math.min(calculatedCount, STAGE00_WAVE_MAX_SHIPS);
  const centerR = pickWaveCenter(player, waveNumber);
  const { approachDir, centerV: rawCenterV } = makeFlybyVelocity(player, centerR, waveNumber);
  const centerV = limitFlybyDv(player.v, centerR, rawCenterV, player.t, celestialSystem);
  const subGroups = makeSubGroupHexes(pickWaveBaseHex());
  const typeIndex = Math.floor(Math.random() * 3);
  const pattern = forcedPattern || (Math.random() < 0.5 ? 'linear' : 'random');

  // 隻数分、位置と識別カラーを割り当てて敵艦を生成する
  const enemies: Enemy[] = [];
  for (let i = 0; i < shipCount; i++) {
    const accent = subGroups[i % subGroups.length]!;
    const position = waveShipPosition(pattern, i, shipCount, centerR, approachDir);
    const state: KinematicState = kinematicState<'eci'>(player.t, position, centerV);
    enemies.push(generateApproachingEnemy(`W${waveNumber}-${i + 1}`, state, accent, accent, typeIndex, waveNumber, worldSfx, fx, scene));
  }
  return enemies;
}
