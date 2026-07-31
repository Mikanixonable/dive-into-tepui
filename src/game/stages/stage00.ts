// Stage 00: 無限耐久サバイバル。弾薬確保後、波状攻撃が自機破壊まで無限に続く
// (撃破数では終わらないので checkWin/onWin は no-op に override する)。
// 波状攻撃の出現ロジック(フェーズ遷移・ウェーブ数・敵配置)はこのステージでしか使わないため、
// 共通化はせずこのファイルに集約する。
import * as THREE from 'three/webgpu';
import * as C from '../const';
import { Stage } from './stage';
import { KEY_MAPPING as K } from '../input/key-mapping';
import type { EntityManager } from '../orbit-entity/entity-manager';
import type { Player } from '../player/player';
import type { Enemy } from '../orbit-entity/enemy';
import type { Hud } from '../hud/hud';
import type { Sfx } from '../../audio/sfx';
import type { EffectsSystem } from '../vfx/effects-system';
import { SimSpeedManager } from '../sim-speed-manager';
import { OrbitState, elementsFromState, orbitState } from '../../physics/orbital';
import { Vec3, add, addScaled, len, norm, randPerp, scale, sub, v3 } from '../../physics/vec3';
import { generateApproachingEnemy } from './spawner/enemy-generator';

export class Stage00 extends Stage {
  static readonly id = '00' as const;
  readonly selectLabel = '[0] 無限耐久サバイバル (Stage 00)';
  readonly selectSub = '常時選択可。弾薬を拾ってから始まる無限の波状攻撃。自機が破壊されるまで続く';
  readonly selectKeys = ['Digit0'];
  readonly initialAmmo = { mags: C.INITIAL_MAGS - 1, rounds: C.MAG_ROUNDS };

  private waveState: 'waiting_for_ammo' | 'spawning_enemies' | 'active_combat' = 'waiting_for_ammo';
  private spawnTimer = 0;
  private waveCount = 0;

  briefingHtml(): string {
    return (
      '<b>サバイバル任務: 弾薬を回収し、無限の敵から生き残れ！</b><br>' +
      '敵は次々と波状攻撃を仕掛けてくる。<br>' +
      '補給マガジンが近くに浮いている — 弾切れ時は回収せよ<br>' +
      `[${K.help.label}] キーで操作方法を表示`
    );
  }

  init(player: Player, entities: EntityManager): number {
    for (let i = 0; i < C.MAX_AMMO; i++) {
      this.logistics.spawnForPlayer(player, C.STAGE00_LOGISTICS_MIN_DIST, C.STAGE00_LOGISTICS_MAX_DIST);
    }
    // 初期状態でもランダムに敵を配置する
    this.spawnWave(player, (enemy) => this.addEnemy(enemy, entities), 'random');
    return 0;
  }

  update(dt: number, player: Player, entities: EntityManager, simTime: number, simSpeed: SimSpeedManager): void {
    if (!this.isPlaying) return;

    this.behaveAllEnemies(dt, player, entities, simTime, simSpeed);

    this.logistics.updateLogistics(simTime, player, true);

    if (this.waveState === 'waiting_for_ammo') return this.updateWaitingForAmmoPhase(player);
    if (this.waveState === 'spawning_enemies') return this.updateSpawningEnemiesPhase(dt, player, entities);
    if (this.waveState === 'active_combat') this.updateActiveCombatPhase(dt, player, entities, simTime);
  }

  checkWin(): boolean { return false; }
  onWin(): void { /* no-op: このステージは撃破数では終わらない */ }

  hudSubStatus(): string {
    return `サバイバル 第${this.waveCount}波`;
  }

  // 1波分の敵を生成してステージに登録する(配置計算は generateWave が行う)。
  private spawnWave(player: Player, addEnemy: (enemy: Enemy) => void, forcedPattern?: 'linear' | 'random'): void {
    const wave = ++this.waveCount;
    const enemies = generateWave(player.state, wave, this._hud, this._sfx, this._fx, this._scene, forcedPattern);
    for (const enemy of enemies) addEnemy(enemy);
  }

  // 「弾薬確保待ち」フェーズ: 弾薬を入手したらウェーブ接近フェーズへ進める。
  private updateWaitingForAmmoPhase(player: Player): void {
    if (player.magsLeft <= 0 && player.roundsInMag <= 0) return;
    this.waveState = 'spawning_enemies';
    this.spawnTimer = C.STAGE00_SPAWN_DELAY;
    this._hud.toast('弾薬を確保した。敵部隊が接近中...', 3000);
  }

  // 「ウェーブ接近予告」フェーズ: カウントダウン後に最初のウェーブを生成する。
  private updateSpawningEnemiesPhase(dt: number, player: Player, entities: EntityManager): void {
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    this.spawnWave(player, (enemy) => this.addEnemy(enemy, entities));
    this.waveState = 'active_combat';
    this.spawnTimer = C.STAGE00_SPAWN_INTERVAL;
  }

  // 「交戦中」フェーズ: 圏外の敵を消しつつ、同時展開数の上限内で次のウェーブを送り込む。
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
  // waveCount は spawnWave() で 1 から始まるが、念のため 0 も同じ扱いにする
  if (waveCount <= 1) return { maxGroups: 1, allowedMaxWaveCount: 2 };
  if (waveCount === 2) return activeGroups > 0 ? { maxGroups: 1, allowedMaxWaveCount: 2 } : { maxGroups: 2, allowedMaxWaveCount: 4 };
  if (waveCount === 3) return { maxGroups: 2, allowedMaxWaveCount: 4 };
  if (waveCount === 4) return activeGroups > 0 ? { maxGroups: 2, allowedMaxWaveCount: 4 } : { maxGroups: 3, allowedMaxWaveCount: Infinity };
  return { maxGroups: 3, allowedMaxWaveCount: Infinity };
}

// ウェーブ出現位置: 自機と同じ高度の水平方向(全方位)にランダムな距離で配置
function pickWaveCenter(player: OrbitState, wave: number): Vec3 {
  const dist = C.STAGE00_SPAWN_DIST_MIN + Math.random() * (C.STAGE00_SPAWN_DIST_MAX - C.STAGE00_SPAWN_DIST_MIN);

  // 第1波は必ず後方(速度ベクトルと逆向き)に出現させる。それ以降はランダムな水平方向
  // (randPerp は単位ベクトルを要求するので、位置ベクトルは norm を通して渡す)。
  let dir: Vec3;
  if (wave === 1) {
    dir = norm(scale(player.v, -1));
  } else {
    dir = randPerp(norm(player.r));
  }

  return add(player.r, scale(dir, dist));
}

// フライバイ初速: 1000m ~ 2000m の範囲ですれ違うようにターゲット位置をずらし、
// 敵の初速度 = 自機の速度 + 接近速度 + わずかな横ブレ とする
function makeFlybyVelocity(player: OrbitState, centerR: Vec3, wave: number): { approachDir: Vec3; centerV: Vec3 } {
  const missDist = C.STAGE00_FLYBY_MISS_DIST_MIN + Math.random() * C.STAGE00_FLYBY_MISS_DIST_RANGE;
  const directDir = norm(sub(player.r, centerR));
  const missPerp = randPerp(directDir);
  const targetPos = add(player.r, scale(missPerp, missDist));

  const approachDir = norm(sub(targetPos, centerR));
  // ウェーブが進むと少し速くなる。ステージ00は無限に続くので、上限を掛けないと相対速度が
  // 際限なく上がって Δv だけで敵の軌道を壊してしまう(近地点の保証は limitFlybyDv が別途行う)。
  const flybySpeed = Math.min(
    C.STAGE00_FLYBY_SPEED + (wave - 1) * C.STAGE00_FLYBY_SPEED_RAMP,
    C.STAGE00_FLYBY_SPEED_MAX,
  );
  const perpDir = randPerp(approachDir);
  const spread = scale(perpDir, Math.random() * C.STAGE00_FLYBY_LATERAL_SPREAD);
  return { approachDir, centerV: add(player.v, add(scale(approachDir, flybySpeed), spread)) };
}

// フライパスの Δv は自機の軌道速度に直接加算されるため、大きすぎると出現した瞬間に
// 近地点を大気圏下(ときには地中)まで引き下げてしまい、敵が出現直後に再突入で消える。
// ここで「近地点高度が REENTRY_ALT + STAGE00_MIN_PERIGEE_MARGIN を下回らない」ことを保証する。
// 方向(どちらから飛んでくるか = 演出)は変えず、大きさだけを二分探索で縮める。
// 自機自身が既に低い軌道にいて Δv = 0 でも安全高度を割る場合は、自機と同じ速度(Δv = 0)を返す。
function limitFlybyDv(playerV: Vec3, centerR: Vec3, centerV: Vec3): Vec3 {
  const minPeAlt = C.REENTRY_ALT + C.STAGE00_MIN_PERIGEE_MARGIN;
  const safe = (v: Vec3): boolean => {
    const el = elementsFromState(centerR, v);
    return el !== null && el.peAlt >= minPeAlt;
  };
  if (safe(centerV)) return centerV;

  const dv = sub(centerV, playerV);
  let lo = 0; // 常に「安全と判定済み(または Δv=0)」側
  let hi = 1; // 常に「危険と判定済み」側
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

// 個体を2~4のサブグループに分け、色相・彩度・明度をわずかにずらす
function makeSubGroupHexes(baseHex: number): number[] {
  const baseColor = new THREE.Color(baseHex);
  const hsl = { h: 0, s: 0, l: 0 };
  baseColor.getHSL(hsl);

  const subGroupCount = 2 + Math.floor(Math.random() * 3);
  const subGroups: number[] = [];
  for (let i = 0; i < subGroupCount; i++) {
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

// 隊列内の各機の配置位置(高度を少し下げるオフセット込み・大気圏突入防止のクランプあり)
function waveShipPosition(pattern: 'linear' | 'random', i: number, shipCount: number, centerR: Vec3, approachDir: Vec3): Vec3 {
  let pos: Vec3;
  if (pattern === 'linear') {
    // 隊列は接近方向に対して後方へ直列に並べる。直線状のものも少しランダムに配置
    const offset = (i - (shipCount - 1) / 2) * C.STAGE00_FORMATION_SPACING;
    const jitter = scale(randPerp(approachDir), (Math.random() - 0.5) * 200);
    pos = add(centerR, add(scale(approachDir, -offset), jitter));
  } else {
    // ランダムな球状の配置
    const randDir = norm(v3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5));
    const randDist = Math.random() * C.STAGE00_FORMATION_SPACING * (shipCount / 2);
    pos = add(centerR, scale(randDir, randDist));
  }

  // 高度を少し下げる (200m~1km)
  const altDrop = C.STAGE00_ALT_OFFSET_MIN + Math.random() * (C.STAGE00_ALT_OFFSET_MAX - C.STAGE00_ALT_OFFSET_MIN);
  const droppedPos = add(pos, scale(norm(pos), altDrop));

  // 安全装置(その1): 出現した瞬間の高度が 90km(大気圏+10km)未満にならないようにする。
  // これは位置だけの保証であり、軌道の近地点を保証するのは limitFlybyDv(速度側)の役目。
  const safeAlt = C.REENTRY_ALT + 10e3;
  const currentAlt = len(droppedPos) - C.R_EARTH;
  if (currentAlt < safeAlt) {
    return scale(norm(droppedPos), C.R_EARTH + safeAlt);
  }
  return droppedPos;
}

// サバイバル波状攻撃1波分を直接生成する(登録は呼び出し側)。
function generateWave(player: OrbitState, waveNumber: number, hud: Hud, sfx: Sfx, fx: EffectsSystem, scene: THREE.Scene, forcedPattern?: 'linear' | 'random'): Enemy[] {
  const calculatedCount = C.STAGE00_WAVE_BASE_SHIPS + Math.floor((waveNumber - 1) * C.STAGE00_WAVE_SHIPS_PER_WAVE);
  const shipCount = Math.min(calculatedCount, C.STAGE00_WAVE_MAX_SHIPS);
  const centerR = pickWaveCenter(player, waveNumber);
  const { approachDir, centerV: rawCenterV } = makeFlybyVelocity(player, centerR, waveNumber);
  // 隊列は centerR から数 km の範囲に散るだけなので、波の中心で近地点を保証すれば全機が安全側に入る。
  const centerV = limitFlybyDv(player.v, centerR, rawCenterV);
  const subGroups = makeSubGroupHexes(pickWaveBaseHex());
  const typeIndex = Math.floor(Math.random() * 3);
  const pattern = forcedPattern || (Math.random() < 0.5 ? 'linear' : 'random');

  const enemies: Enemy[] = [];
  for (let i = 0; i < shipCount; i++) {
    const accent = subGroups[i % subGroups.length]!;
    const position = waveShipPosition(pattern, i, shipCount, centerR, approachDir);
    const state: OrbitState = orbitState(player.t, position, centerV);
    enemies.push(generateApproachingEnemy(`W${waveNumber}-${i + 1}`, state, C.STAGE0_ENEMY_HP, accent, accent, typeIndex, waveNumber, hud, sfx, fx, scene));
  }
  return enemies;
}
