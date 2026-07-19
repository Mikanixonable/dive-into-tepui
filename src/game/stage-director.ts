// ステージ構成(敵配置)・ウェーブ生成・ステージ専用のタイマー/進行状態。
// game.ts を import しない — 依存は StageCtx 引数・コンストラクタ注入・コールバックのみ。
import * as THREE from 'three/webgpu';
import {
  MU_EARTH,
  OrbitState,
  R_EARTH,
  stateFromElements,
} from '../physics/orbital';
import { qFromForwardUp, randomQuat } from '../physics/attitude';
import {
  Vec3,
  add,
  clone,
  cross,
  len,
  norm,
  randPerp,
  randSym,
  rotateAxis,
  scale,
  sub,
  v3,
} from '../physics/vec3';
import * as C from './const';
import { Enemy } from './entities';
import { Hud } from '../hud/hud';
import { Sfx } from '../audio/sfx';
import { buildStage0EnemyShip } from '../render/ships';
import { getStageDefinition, StageEnemyPreset } from './stage-data';
import { Player } from './player/player';

export interface EnemySpec {
  name: string;
  state: OrbitState;
  hp: number;
  accent: number;
}

// updateStage00 / spawnStage00Wave / updateStage0Timer が必要とする、Game 側の
// 現在状態のスナップショット(毎フレーム渡す)。enemies は読み取り参照
// (要素の alive 等はミューテートしてよいが、生成累計数の表示には totalEnemies を
// 使う — enemies は撃破された個体から prune されるため配列長は「残存数」)。
// 敵の追加は addEnemy(game.ts 側で Simulator への登録と軌道線の生成まで行う)を通す。
export interface StageCtx {
  phase: string;
  player: Player;
  enemies: readonly Enemy[];
  totalEnemies: number;
  addEnemy(enemy: Enemy, orbitLineColor: number): void;
  scene: THREE.Scene;
  shots: number;
  hits: number;
  kills: number;
  magsLeft: number;
  roundsInMag: number;
  setPhase(phase: 'playing' | 'won' | 'lost' | 'timeup'): void;
}

export class StageDirector {
  // 第零ステージ専用: 制限時間内の撃墜数を競うスコアアタックの残り時間(実秒)
  stage0TimeLeft = C.STAGE0_TIME_LIMIT;

  stage00Phase: 'waiting_for_ammo' | 'spawning_enemies' | 'active_combat' | 'game_over' = 'waiting_for_ammo';
  stage00SpawnTimer = 0;
  stage00WaveCount = 0;

  constructor(
    private readonly hud: Hud,
    private readonly sfx: Sfx,
    readonly stage: number,
    private readonly spawnMagPickup: (minDist?: number, maxDist?: number) => void,
  ) {}

  // ステージごとの敵軌道。ステージ0は自機周囲 5km 以内に密集する近接戦闘訓練、
  // ステージ1は自機軌道の近傍、ステージ2は低軌道 2 機 + モルニヤ級高楕円軌道 3 機。
  makeEnemySpecs(base: OrbitState): EnemySpec[] {
    const r0 = len(base.r);
    const hHat = norm(cross(base.r, base.v));
    const stageDef = getStageDefinition(this.stage);
    if (stageDef.enemyLayout.kind === 'none') return []; // ステージ00は初期敵なしで動的スポーンする
    if (stageDef.enemyLayout.kind === 'training-cluster') return this.makeStage0Specs(base, hHat);

    const phased = this.makePhasedFactory(base, hHat, r0);
    return this.buildPresetSpecs(stageDef.enemyLayout.presets, phased, r0);
  }

  update(dt: number, ctx: StageCtx): void {
    if (this.stage === -1) this.updateStage00(dt, ctx);
    if (this.stage === 0) this.updateStage0Timer(dt, ctx);
  }

  private makePhasedFactory(base: OrbitState, hHat: Vec3, radius: number): (dAlong: number) => OrbitState {
    return (dAlong: number): OrbitState => {
      const ang = dAlong / radius;
      return {
        r: rotateAxis(base.r, hHat, ang),
        v: rotateAxis(base.v, hHat, ang),
      };
    };
  }

  private makeMolniyaSpec(raan: number, nu: number, name: string, accent: number): EnemySpec {
    const rp = R_EARTH + 1200e3;
    const ra = R_EARTH + 39400e3;
    const a = (rp + ra) / 2;
    const e = (ra - rp) / (ra + rp);
    return {
      name,
      state: stateFromElements(a, e, (63.4 * Math.PI) / 180, raan, -Math.PI / 2, nu),
      hp: 3,
      accent,
    };
  }

  private buildPresetSpecs(
    presets: StageEnemyPreset[],
    phased: (dAlong: number) => OrbitState,
    radius: number,
  ): EnemySpec[] {
    return presets.map((preset): EnemySpec => {
      switch (preset.kind) {
        case 'phased':
          return { name: preset.name, state: phased(preset.dAlong), hp: preset.hp, accent: preset.accent };
        case 'coelliptic':
          return {
            name: preset.name,
            state: this.makeCoellipticState(phased(preset.dAlong), radius + preset.altitudeOffset),
            hp: preset.hp,
            accent: preset.accent,
          };
        case 'crossing':
          return {
            name: preset.name,
            state: this.makeCrossingState(phased(preset.dAlong)),
            hp: preset.hp,
            accent: preset.accent,
          };
        case 'elliptic':
          return {
            name: preset.name,
            state: this.makeEllipticState(phased(preset.dAlong)),
            hp: preset.hp,
            accent: preset.accent,
          };
        case 'molniya':
          return this.makeMolniyaSpec(preset.raan, preset.nu, preset.name, preset.accent);
      }
    });
  }

  private makeCoellipticState(state: OrbitState, altitude: number): OrbitState {
    return {
      r: scale(norm(state.r), altitude),
      v: scale(norm(state.v), Math.sqrt(MU_EARTH / altitude)),
    };
  }

  private makeCrossingState(state: OrbitState): OrbitState {
    return {
      r: state.r,
      v: rotateAxis(state.v, norm(state.r), (0.4 * Math.PI) / 180),
    };
  }

  private makeEllipticState(state: OrbitState): OrbitState {
    return {
      r: state.r,
      v: scale(state.v, 1.006),
    };
  }

  // 第零ステージ: 色分けされた 5 グループ(各 10 機)を自機周囲 5km 以内に配置する。
  private makeStage0Specs(base: OrbitState, hHat: Vec3): EnemySpec[] {
    const vHat = norm(base.v);
    const rHat = norm(base.r);
    const specs: EnemySpec[] = [];
    const groupCount = C.STAGE0_GROUP_ACCENTS.length;
    const safeRange = C.STAGE0_MAX_RANGE * C.STAGE0_SAFE_RANGE_FACTOR; // マージンを残して確実に5km以内に収める

    for (let gi = 0; gi < groupCount; gi++) {
      const theta = (gi / groupCount) * Math.PI * 2;
      const centerDist = safeRange * (C.STAGE0_GROUP_CENTER_DIST_MIN + Math.random() * C.STAGE0_GROUP_CENTER_DIST_RANGE);
      const cAlong = Math.cos(theta) * centerDist;
      const cNormal = Math.sin(theta) * centerDist;
      const cRadial = randSym(safeRange * C.STAGE0_GROUP_RADIAL_FACTOR);

      for (let i = 0; i < C.STAGE0_PER_GROUP; i++) {
        const jAlong = cAlong + randSym(C.STAGE0_JITTER_ALONG);
        const jNormal = cNormal + randSym(C.STAGE0_JITTER_NORMAL);
        const jRadial = cRadial + randSym(C.STAGE0_JITTER_RADIAL);
        let off = add(scale(vHat, jAlong), scale(hHat, jNormal));
        off = add(off, scale(rHat, jRadial));
        const offLen = len(off);
        if (offLen > safeRange) off = scale(off, safeRange / offLen);

        specs.push({
          name: `${C.STAGE0_GROUP_LABELS[gi]}-${i + 1}`,
          state: { r: add(base.r, off), v: clone(base.v) },
          hp: C.STAGE0_ENEMY_HP,
          accent: C.STAGE0_GROUP_ACCENTS[gi]!,
        });
      }
    }
    return specs;
  }

  // 第零ステージ開始時: 自機の近く(1km 以内)に補給マガジンを複数浮かべておく
  spawnStage0InitialAmmo(): void {
    for (let i = 0; i < C.STAGE0_AMMO_PICKUPS; i++) {
      this.spawnMagPickup(C.STAGE0_AMMO_MIN_DIST, C.STAGE0_AMMO_MAX_DIST);
    }
  }

  // 第零ステージの制限時間(実秒。タイムワープの影響を受けない)を減算し、
  // 0 になったらスコアアタック終了として結果画面を表示する。
  updateStage0Timer(dt: number, ctx: StageCtx): void {
    this.stage0TimeLeft -= dt;
    if (this.stage0TimeLeft <= 0) {
      this.stage0TimeLeft = 0;
      ctx.setPhase('timeup');
      this.sfx.setThrust(false);
      this.sfx.stopBgm();
      const acc = ctx.shots > 0 ? ((ctx.hits / ctx.shots) * 100).toFixed(1) : '0.0';
      this.hud.showEnd(
        true,
        `撃墜 ${ctx.kills} / ${ctx.totalEnemies} 機<br>` +
        `発射 ${ctx.shots} 発 / 命中 ${ctx.hits} 発 (命中率 ${acc}%)`,
        'TIME UP',
      );
    }
  }

  // ステージ00(サバイバル)開始時:
  spawnStage00InitialAmmo(ctx: StageCtx): void {
    for (let i = 0; i < C.MAX_MAG_PICKUPS; i++) {
      this.spawnMagPickup(C.STAGE00_AMMO_MIN_DIST, C.STAGE00_AMMO_MAX_DIST);
    }
    // 初期状態でもランダムに敵を配置する
    this.spawnStage00Wave(ctx, 'random');
  }

  updateStage00(dt: number, ctx: StageCtx): void {
    if (ctx.phase !== 'playing') return;
    if (this.stage00Phase === 'waiting_for_ammo') return this.updateStage00WaitForAmmo(ctx);
    if (this.stage00Phase === 'spawning_enemies') return this.updateStage00SpawningEnemies(dt, ctx);
    if (this.stage00Phase === 'active_combat') this.updateStage00ActiveCombat(dt, ctx);
  }

  private updateStage00WaitForAmmo(ctx: StageCtx): void {
    if (ctx.magsLeft <= 0 && ctx.roundsInMag <= 0) return;
    this.stage00Phase = 'spawning_enemies';
    this.stage00SpawnTimer = C.STAGE00_SPAWN_DELAY;
    this.hud.toast('弾薬を確保した。敵部隊が接近中...', 3000);
  }

  private updateStage00SpawningEnemies(dt: number, ctx: StageCtx): void {
    this.stage00SpawnTimer -= dt;
    if (this.stage00SpawnTimer > 0) return;
    this.spawnStage00Wave(ctx);
    this.stage00Phase = 'active_combat';
    this.stage00SpawnTimer = C.STAGE00_SPAWN_INTERVAL;
  }

  private updateStage00ActiveCombat(dt: number, ctx: StageCtx): void {
    this.despawnOutOfRangeStage00Enemies(ctx);
    const activeGroups = this.countStage00ActiveGroups(ctx);
    const limits = this.resolveStage00SpawnLimits(activeGroups);
    if (activeGroups === 0) this.stage00SpawnTimer = 0;
    if (!this.canSpawnNextStage00Wave(activeGroups, limits)) return;
    this.stage00SpawnTimer -= dt;
    if (this.stage00SpawnTimer > 0) return;
    this.spawnStage00Wave(ctx);
    this.stage00SpawnTimer = C.STAGE00_SPAWN_INTERVAL;
    this.hud.toast(`波状攻撃 第${this.stage00WaveCount}波 接近中！`, 3000);
  }

  private despawnOutOfRangeStage00Enemies(ctx: StageCtx): void {
    for (const enemy of ctx.enemies) {
      if (!enemy.alive) continue;
      const dist = len(sub(enemy.state.r, ctx.player.state.r));
      if (dist <= C.STAGE00_MAX_RANGE) continue;
      enemy.alive = false;
      enemy.dispose();
    }
  }

  private countStage00ActiveGroups(ctx: StageCtx): number {
    const activeWaves = new Set<number>();
    for (const enemy of ctx.enemies) {
      if (enemy.alive && enemy.waveId !== undefined) activeWaves.add(enemy.waveId);
    }
    return activeWaves.size;
  }

  private resolveStage00SpawnLimits(activeGroups: number): { maxGroups: number; allowedMaxWaveCount: number } {
    if (this.stage00WaveCount >= 4) {
      if (this.stage00WaveCount >= 5 || activeGroups === 0) {
        return { maxGroups: 3, allowedMaxWaveCount: Infinity };
      }
      return { maxGroups: 2, allowedMaxWaveCount: 4 };
    }
    if (this.stage00WaveCount >= 2) {
      if (this.stage00WaveCount >= 3 || activeGroups === 0) {
        return { maxGroups: 2, allowedMaxWaveCount: 4 };
      }
      return { maxGroups: 1, allowedMaxWaveCount: 2 };
    }
    return { maxGroups: 1, allowedMaxWaveCount: 2 };
  }

  private canSpawnNextStage00Wave(
    activeGroups: number,
    limits: { maxGroups: number; allowedMaxWaveCount: number },
  ): boolean {
    return activeGroups < limits.maxGroups && this.stage00WaveCount < limits.allowedMaxWaveCount;
  }

  spawnStage00Wave(ctx: StageCtx, forcedPattern?: 'linear' | 'random'): void {
    const plan = this.buildStage00WavePlan(ctx, forcedPattern);
    for (let i = 0; i < plan.shipCount; i++) {
      const accent = plan.subGroups[i % plan.subGroups.length]!;
      const position = waveShipPosition(plan.pattern, i, plan.shipCount, plan.centerR, plan.approachDir);
      spawnWaveShip(ctx, `W${plan.wave}-${i + 1}`, position, clone(plan.centerV), accent, plan.typeIndex, plan.wave);
    }
  }

  private buildStage00WavePlan(
    ctx: StageCtx,
    forcedPattern?: 'linear' | 'random',
  ): {
    wave: number;
    shipCount: number;
    centerR: Vec3;
    approachDir: Vec3;
    centerV: Vec3;
    subGroups: number[];
    typeIndex: number;
    pattern: 'linear' | 'random';
  } {
    this.stage00WaveCount++;
    const wave = this.stage00WaveCount;
    const shipCount = C.STAGE00_WAVE_BASE_SHIPS + Math.floor((wave - 1) * C.STAGE00_WAVE_SHIPS_PER_WAVE);
    const centerR = pickWaveCenter(ctx.player.state, wave);
    const { approachDir, centerV } = makeFlybyVelocity(ctx.player.state, centerR, wave);
    const subGroups = makeSubGroupHexes(pickWaveBaseHex());
    const typeIndex = Math.floor(Math.random() * 3);
    const pattern = forcedPattern || (Math.random() < 0.5 ? 'linear' : 'random');
    return { wave, shipCount, centerR, approachDir, centerV, subGroups, typeIndex, pattern };
  }
}

// ウェーブ出現位置: 自機の後方/前方/上方/側方いずれか(第1波は必ず後方)
function pickWaveCenter(player: OrbitState, wave: number): Vec3 {
  const types = ['behind', 'front', 'above', 'side'];
  const type = wave === 1 ? 'behind' : types[Math.floor(Math.random() * types.length)];

  const dist = C.STAGE00_SPAWN_DIST_MIN + Math.random() * (C.STAGE00_SPAWN_DIST_MAX - C.STAGE00_SPAWN_DIST_MIN);
  const r0 = player.r;
  const hHat = norm(cross(r0, player.v));
  const rHat = norm(r0);
  const vHat = cross(hHat, rHat);

  const dr = (Math.random() - 0.5) * C.STAGE00_PLACEMENT_JITTER;
  if (type === 'behind') return add(r0, add(scale(vHat, -dist), scale(rHat, dr)));
  if (type === 'front') return add(r0, add(scale(vHat, dist), scale(rHat, dr)));
  if (type === 'above') return add(r0, add(scale(rHat, dist), scale(vHat, dr)));
  const sideSign = Math.random() < 0.5 ? 1 : -1; // side
  return add(r0, add(scale(hHat, dist * sideSign), scale(rHat, dr)));
}

// フライパス初速: 1000m ~ 2000m の範囲ですれ違うようにターゲット位置をずらし、
// 敵の初速度 = 自機の速度 + 接近速度 + わずかな横ブレ とする
function makeFlybyVelocity(
  player: OrbitState,
  centerR: Vec3,
  wave: number
): { approachDir: Vec3; centerV: Vec3 } {
  const missDist = C.STAGE00_FLYBY_MISS_DIST_MIN + Math.random() * C.STAGE00_FLYBY_MISS_DIST_RANGE;
  const directDir = norm(sub(player.r, centerR));
  const missPerp = randPerp(directDir);
  const targetPos = add(player.r, scale(missPerp, missDist));

  const approachDir = norm(sub(targetPos, centerR));
  const flybySpeed = C.STAGE00_FLYBY_SPEED + (wave - 1) * C.STAGE00_FLYBY_SPEED_RAMP; // ウェーブが進むと少し速くなる
  const perpDir = randPerp(approachDir);
  const spread = scale(perpDir, Math.random() * C.STAGE00_FLYBY_LATERAL_SPREAD);
  return { approachDir, centerV: add(player.v, add(scale(approachDir, flybySpeed), spread)) };
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

// 隊列内の各機の配置位置(高度を少し下げるオフセット込み)
function waveShipPosition(
  pattern: 'linear' | 'random',
  i: number,
  shipCount: number,
  centerR: Vec3,
  approachDir: Vec3
): Vec3 {
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
  return add(pos, scale(norm(pos), altDrop));
}

// 敵機を生成して ctx.addEnemy で登録する(配列・シーン・軌道線は game.ts 側が管理)
function spawnWaveShip(
  ctx: StageCtx,
  name: string,
  r: Vec3,
  v: Vec3,
  accent: number,
  typeIndex: number,
  waveId: number
): void {
  const enemy = new Enemy(
    name,
    { r, v },
    buildStage0EnemyShip(accent, typeIndex),
    {
      // 機首をプログレード、背を天頂に
      q: qFromForwardUp(v, r) ?? randomQuat(),
      w: v3(0, 0, 0),
      inertia: v3(1, 1, 1),
    },
    C.STAGE0_ENEMY_HP,
    accent,
    waveId,
    ctx.scene,
  );
  ctx.addEnemy(enemy, accent);
}
