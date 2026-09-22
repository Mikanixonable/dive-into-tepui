// 波状攻撃: 弾薬確保待ち → 遅延後の初回湧き → 交戦圏内数に応じた周期湧きへ進むフェーズ機械と、
// ウェーブ1回分の隻数・編成・接近軌道の生成。
import * as THREE from 'three/webgpu';
import { ENGAGEMENT_RANGE } from '../../dynamic/engagement-zone';
import { kinematicState, type KinematicState } from '../../../physics/kinematic-state';
import { apsisAltitudes, orbitalElementsOf } from '../../../physics/elements';
import { ellipsoidAltitude } from '../../../physics/atmosphere';
import { frameOfCelestialBody, framePoint, toFramePoint, toFrameState, toInertialPoint } from '../../../physics/frame';
import { strongestAttractor } from '../../../physics/attractor';
import { add, addScaled, len, norm, randPerp, randVec, scale, sub, v3, type Vec3 } from '../../../math/vec3';
import { generateApproachingEnemy } from '../spawner/enemy-generator';
import type { CelestialBody } from '../../../physics/celestial-body';
import type { Enemy } from '../../dynamic/dynamic-entity/enemy';
import type { EntityIdAllocators } from '../../dynamic/dynamic-entity/entity-id';
import type { ModularShip } from '../../ship/modular-ship';
import type { StageOutcome } from '../stage-outcome';
import type { RunEventSink } from '../../run-events';

// 波状攻撃が敵を追加し、交戦圏外へ出た敵の消滅を記録するステージのインターフェース。
export interface WaveAttackStage extends StageOutcome {
  // 敵を登録し、出撃数をスコアへ記録する。
  addEnemy(enemy: Enemy): void;
}

const REENTRY_ALT = 80e3; // 敵の軌道の近地点余裕を測る基準高度 [m]

const STAGE00_SPAWN_DELAY = 10; // 弾取得からスポーンまでの遅延 [s]
const STAGE00_FORMATION_SPACING = 200; // 編隊の機体間隔 [m]
const STAGE00_ALT_OFFSET_MIN = -1000; // 自機よりどれくらい低くするか [m]
const STAGE00_ALT_OFFSET_MAX = -200;
const STAGE00_SPAWN_INTERVAL = 30.0; // 波状攻撃の間隔 [s]
const STAGE00_CLEARED_SPAWN_INTERVAL = 2.0; // 交戦中の集団が 0 になったときの波状攻撃の間隔 [s]
const STAGE00_SPAWN_DIST_MIN = 10000; // 敵集団のスポーン距離
const STAGE00_SPAWN_DIST_MAX = 14000;
const STAGE00_FLYBY_SPEED = 200.0; // フライパスの相対速度 [m/s]
const STAGE00_WAVE_BASE_SHIPS = 5; // 第1波の機数
const STAGE00_WAVE_SHIPS_PER_WAVE = 2; // 波が進むごとに増える機数
const STAGE00_WAVE_MAX_SHIPS = 30; // 1ウェーブの最大機数上限
const STAGE00_FLYBY_MISS_DIST_MIN = 1000; // フライパスのすれ違い距離下限 [m]
const STAGE00_FLYBY_MISS_DIST_RANGE = 1000; // 同、上限までの幅 [m]
const STAGE00_FLYBY_SPEED_RAMP = 10; // 波が進むごとのフライパス速度増加 [m/s]

// フライパス速度の上限 [m/s]。波数に上限が無いので、これが無いとフライパスの Δv だけで敵の軌道が
// 壊れる(近地点が地中に落ちる)。400 m/s なら 30km の交戦圏を約75秒で通過する。
const STAGE00_FLYBY_SPEED_MAX = 400.0;

// 敵の軌道が保つべき近地点高度の余裕 [m](大気圏突入高度 REENTRY_ALT に加算する)。
const STAGE00_MIN_PERIGEE_MARGIN = 40e3;
const STAGE00_FLYBY_LATERAL_SPREAD = 20; // フライパス初速の横ブレ最大 [m/s]

type WaveState = 'waiting_for_ammo' | 'spawning_enemies' | 'active_combat';

export interface SerializedWaveAttack {
  readonly waveState: WaveState;
  readonly spawnTimer: number;
  readonly waveCount: number;
}

export class WaveAttack {
  public get waveCount(): number { return this._waveCount; }

  // 渡した進行から始める。省いた進行は、弾薬の確保を待つ第0波から始まる。
  public constructor(
    private readonly events: RunEventSink,
    private readonly scene: THREE.Scene,
    private readonly attractors: readonly CelestialBody[],
    private readonly idAllocators: EntityIdAllocators,
    private waveState: WaveState = 'waiting_for_ammo',
    private spawnTimer = 0,
    private _waveCount = 0,
  ) {}

  // 直列化した進行から復元する。
  public static deserialize(
    serialized: SerializedWaveAttack,
    events: RunEventSink,
    scene: THREE.Scene,
    attractors: readonly CelestialBody[],
    idAllocators: EntityIdAllocators,
  ): WaveAttack {
    const { waveState, spawnTimer, waveCount } = serialized;
    // null も欠けと同じく新しい進行の初期値から始める(既定引数は undefined でしか働かない)。
    return new WaveAttack(
      events, scene, attractors, idAllocators, waveState ?? undefined, spawnTimer ?? undefined, waveCount ?? undefined,
    );
  }

  // ウェーブ番号を1つ進め、生成した敵を stage へ足す。
  public spawnWave(
    player: ModularShip, stage: Pick<WaveAttackStage, 'addEnemy'>, forcedPattern?: 'linear' | 'random',
  ): void {
    const wave = ++this._waveCount;
    const enemies = generateWave(
      player.motion.state, wave, this.attractors,
      this.scene, this.idAllocators, forcedPattern,
    );
    for (const enemy of enemies) stage.addEnemy(enemy);
  }

  // フェーズ機械を1フレーム分進める。敵は stage へ足し、交戦圏外へ出た敵の消滅を stage へ記録する。
  public update(
    dt: number, player: ModularShip, enemies: readonly Enemy[], simTime: number, stage: WaveAttackStage,
  ): void {
    if (this.waveState === 'waiting_for_ammo') return this.updateWaitingForAmmoPhase(player);
    if (this.waveState === 'spawning_enemies') return this.updateSpawningEnemiesPhase(dt, player, stage);
    if (this.waveState === 'active_combat') this.updateActiveCombatPhase(dt, player, enemies, simTime, stage);
  }

  // 自機が弾薬を確保するまで待ち、確保でき次第 spawning_enemies フェーズへ進める。
  private updateWaitingForAmmoPhase(player: ModularShip): void {
    if (player.magsLeft <= 0 && player.roundsInMag <= 0) return;
    this.waveState = 'spawning_enemies';
    this.spawnTimer = STAGE00_SPAWN_DELAY;
    this.events.record({ kind: 'waveAttackArmed' });
  }

  // 遅延タイマーが尽きたら最初のウェーブを湧かせ、active_combat フェーズへ進める。
  private updateSpawningEnemiesPhase(dt: number, player: ModularShip, stage: WaveAttackStage): void {
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    this.spawnWave(player, stage);
    this.waveState = 'active_combat';
    this.spawnTimer = STAGE00_SPAWN_INTERVAL;
  }

  // 交戦圏外の敵を消し、同時展開数の上限内でタイマーに従い次のウェーブを湧かせる。
  private updateActiveCombatPhase(
    dt: number, player: ModularShip, enemies: readonly Enemy[], simTime: number, stage: WaveAttackStage,
  ): void {
    despawnOutOfRangeEnemies(enemies, player, ENGAGEMENT_RANGE, simTime, stage);
    const activeGroups = countActiveWaveGroups(enemies);
    if (activeGroups === 0) {
      // 短縮先を 0 にすると、湧いた波が同じフレームで離脱しきる時間加速下で毎フレーム湧き続ける。
      this.spawnTimer = Math.min(this.spawnTimer, STAGE00_CLEARED_SPAWN_INTERVAL);
    }
    if (activeGroups >= maxWaveGroups(this._waveCount)) return;
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    this.spawnWave(player, stage);
    this.spawnTimer = STAGE00_SPAWN_INTERVAL;
    this.events.record({ kind: 'waveSpawned', wave: this._waveCount });
  }

  // 進行を直列化した形へ畳む。
  public serialize(): SerializedWaveAttack {
    return { waveState: this.waveState, spawnTimer: this.spawnTimer, waveCount: this._waveCount };
  }
}

// 自機から maxRange より離れた敵を交戦圏外として消す。
function despawnOutOfRangeEnemies(
  enemies: readonly Enemy[], player: ModularShip, maxRange: number, simTime: number, activeStage: StageOutcome,
): void {
  for (const enemy of enemies) {
    if (!enemy.motion.alive) continue;
    if (len(sub(enemy.motion.state.r, player.motion.state.r)) <= maxRange) continue;
    enemy.despawn(simTime, activeStage);
  }
}

// 生存中のウェーブ(waveId)がいくつ同時に交戦中かを数える。
function countActiveWaveGroups(enemies: readonly Enemy[]): number {
  const activeWaves = new Set<number>();
  for (const enemy of enemies) {
    if (enemy.motion.alive && enemy.waveId !== null) activeWaves.add(enemy.waveId);
  }
  return activeWaves.size;
}

// そこまでに湧いた波数に対する、同時に交戦してよいウェーブ数の上限。
function maxWaveGroups(waveCount: number): number {
  if (waveCount <= 1) return 1;
  if (waveCount <= 3) return 2;
  return 3;
}

// ウェーブ出現位置: 自機と同じ高度の水平方向(全方位)にランダムな距離で配置する。水平と後方は、
// 自機の位置で最も強く引く天体に対して取る。
function pickWaveCenter(player: KinematicState, wave: number, attractors: readonly CelestialBody[]): Vec3 {
  const dist = STAGE00_SPAWN_DIST_MIN + Math.random() * (STAGE00_SPAWN_DIST_MAX - STAGE00_SPAWN_DIST_MIN);
  const center = strongestAttractor(player.r, attractors, player.t);
  const rel = toFrameState(frameOfCelestialBody(center, player.t), player);

  // 第1波は必ず後方(中心天体に対する速度と逆向き)に出現させる。
  const dir = wave === 1 ? norm(scale(rel.v, -1)) : randPerp(norm(rel.r));
  return add(player.r, scale(dir, dist));
}

// ウェーブ中心が自機の近傍を通過するフライバイの接近方向と速度を求める。
function makeFlybyVelocity(player: KinematicState, centerR: Vec3, wave: number): { approachDir: Vec3; centerV: Vec3 } {
  const missDist = STAGE00_FLYBY_MISS_DIST_MIN + Math.random() * STAGE00_FLYBY_MISS_DIST_RANGE;
  const directDir = norm(sub(player.r, centerR));
  const missPerp = randPerp(directDir);
  const targetPos = add(player.r, scale(missPerp, missDist));

  const approachDir = norm(sub(targetPos, centerR));
  // ウェーブが進むほど接近速度を上げる。上限があるのは、速いほど Δv が軌道そのものを壊すため。
  const flybySpeed = Math.min(
    STAGE00_FLYBY_SPEED + (wave - 1) * STAGE00_FLYBY_SPEED_RAMP,
    STAGE00_FLYBY_SPEED_MAX,
  );
  const perpDir = randPerp(approachDir);
  const spread = scale(perpDir, Math.random() * STAGE00_FLYBY_LATERAL_SPREAD);
  return { approachDir, centerV: add(player.v, add(scale(approachDir, flybySpeed), spread)) };
}

// 近地点高度が最低ラインを下回らないよう、Δv の大きさを縮める。
function limitFlybyDv(playerV: Vec3, centerR: Vec3, centerV: Vec3, t: number, attractors: readonly CelestialBody[]): Vec3 {
  const minPeAlt = REENTRY_ALT + STAGE00_MIN_PERIGEE_MARGIN;
  const center = strongestAttractor(centerR, attractors, t);
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

// ウェーブの基調色を、アースカラー7割 / 寒色系2割 / アクセントカラー1割の確率で選ぶ。
function pickWaveBaseHex(): number {
  // 系統を選び、その系統の中から1色を等確率で引く
  const randCol = Math.random();
  if (randCol < 0.7) {
    const earthColors = [0xc2b280, 0x808080, 0xb2beb5, 0x8b4513, 0xc3b091, 0x556b2f, 0x8f9779, 0x5f9ea0];
    return earthColors[Math.floor(Math.random() * earthColors.length)]!;
  }
  if (randCol < 0.9) {
    const coolColors = [0x722f37, 0x8a2be2, 0x0000ff, 0x00ffff, 0x40e0d0, 0x008000, 0x9acd32];
    return coolColors[Math.floor(Math.random() * coolColors.length)]!;
  }
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

// ウェーブ中心を基準に、パターンに応じた個別の艦の初期位置を求める。高度は、その位置で最も強く
// 引く天体の基準面から測る。
function waveShipPosition(
  pattern: 'linear' | 'random', i: number, shipCount: number, centerR: Vec3, approachDir: Vec3,
  attractors: readonly CelestialBody[], t: number,
): Vec3 {
  let pos: Vec3;
  if (pattern === 'linear') {
    const offset = (i - (shipCount - 1) / 2) * STAGE00_FORMATION_SPACING;
    const jitter = scale(randPerp(approachDir), (Math.random() - 0.5) * 200);
    pos = add(centerR, add(scale(approachDir, -offset), jitter));
  } else {
    const randDir = norm(randVec(1));
    const randDist = Math.random() * STAGE00_FORMATION_SPACING * (shipCount / 2);
    pos = add(centerR, scale(randDir, randDist));
  }

  // 中心天体から見た鉛直方向へ高度を下げる。
  const center = strongestAttractor(pos, attractors, t);
  const frame = frameOfCelestialBody(center, t);
  const relPoint = toFramePoint(frame, pos);
  const rel = v3(relPoint.x, relPoint.y, relPoint.z);
  const altDrop = STAGE00_ALT_OFFSET_MIN + Math.random() * (STAGE00_ALT_OFFSET_MAX - STAGE00_ALT_OFFSET_MIN);
  const dropped = addScaled(rel, norm(rel), altDrop);

  // 出現高度が大気圏上限(+10km)を下回るなら、鉛直方向へ持ち上げてそこへ揃える。
  const safeAlt = REENTRY_ALT + 10e3;
  const atm = center.atmosphereAt(t);
  const alt = atm !== null ? ellipsoidAltitude(dropped, atm) : len(dropped) - center.def.radius;
  const placed = alt < safeAlt ? addScaled(dropped, norm(dropped), safeAlt - alt) : dropped;
  return toInertialPoint(frame, framePoint(placed.x, placed.y, placed.z));
}

// ウェーブ番号に応じた隻数・編成・接近軌道を決め、敵艦の配列を生成する。
export function generateWave(
  player: KinematicState, waveNumber: number, attractors: readonly CelestialBody[],
  scene: THREE.Scene, idAllocators: EntityIdAllocators, forcedPattern?: 'linear' | 'random',
): Enemy[] {
  const calculatedCount = STAGE00_WAVE_BASE_SHIPS + Math.floor((waveNumber - 1) * STAGE00_WAVE_SHIPS_PER_WAVE);
  const shipCount = Math.min(calculatedCount, STAGE00_WAVE_MAX_SHIPS);
  const centerR = pickWaveCenter(player, waveNumber, attractors);
  const { approachDir, centerV: rawCenterV } = makeFlybyVelocity(player, centerR, waveNumber);
  const centerV = limitFlybyDv(player.v, centerR, rawCenterV, player.t, attractors);
  const subGroups = makeSubGroupHexes(pickWaveBaseHex());
  const typeIndex = Math.floor(Math.random() * 3);
  const pattern = forcedPattern || (Math.random() < 0.5 ? 'linear' : 'random');

  // 隻数分、位置と識別カラーを割り当てて敵艦を生成する
  const enemies: Enemy[] = [];
  for (let i = 0; i < shipCount; i++) {
    const accent = subGroups[i % subGroups.length]!;
    const position = waveShipPosition(pattern, i, shipCount, centerR, approachDir, attractors, player.t);
    const state: KinematicState = kinematicState<'eci'>(player.t, position, centerV);
    enemies.push(generateApproachingEnemy(
      `W${waveNumber}-${i + 1}`, state, attractors, accent, accent, typeIndex, waveNumber, scene, idAllocators,
      `wave-${waveNumber}-group-${i % subGroups.length}`,
    ));
  }
  return enemies;
}
