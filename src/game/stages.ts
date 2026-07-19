// ステージ構成(敵配置)・ウェーブ生成・ステージ専用のタイマー/進行状態。
// game.ts を import しない — 依存は StageCtx 引数・コンストラクタ注入・コールバックのみ。
import * as THREE from 'three/webgpu';
import {
  MU_EARTH,
  OrbitState,
  R_EARTH,
  stateFromElements,
} from '../physics/orbital';
import { randomQuat } from '../physics/attitude';
import {
  Vec3,
  add,
  clone,
  cross,
  dot,
  len,
  lenSq,
  norm,
  rotateAxis,
  scale,
  sub,
  v3,
} from '../physics/vec3';
import * as C from './const';
import { Ship } from './entities';
import { Hud } from './hud';
import { Sfx } from './audio';
import { buildStage0EnemyShip } from '../render/ships';
import { OrbitLine } from '../render/orbitline';

export interface EnemySpec {
  name: string;
  state: OrbitState;
  hp: number;
  accent: number;
}

function randSym(amp: number): number {
  return (Math.random() * 2 - 1) * amp;
}

function randVec(amp: number): Vec3 {
  return v3(randSym(amp), randSym(amp), randSym(amp));
}

// fwd に直交するランダム単位ベクトル(散布界用)。game.ts の randPerp と同一実装。
function randPerp(fwd: Vec3): Vec3 {
  for (; ;) {
    const r = randVec(1);
    const p = sub(r, scale(fwd, dot(r, fwd)));
    if (lenSq(p) > 1e-6) return norm(p);
  }
}

// updateStage00 / spawnStage00Wave / updateStage0Timer が必要とする、Game 側の
// 現在状態のスナップショット(毎フレーム渡す)。enemies / enemyOrbitLines / scene は
// 参照渡しでミューテートする(game.ts 側の配列・シーンをそのまま操作する)。
export interface StageCtx {
  phase: string;
  player: Ship;
  enemies: Ship[];
  enemyOrbitLines: OrbitLine[];
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
    private readonly spawnMagPickup: (minDist?: number, maxDist?: number) => void,
  ) {}

  // ステージごとの敵軌道。ステージ0は自機周囲 5km 以内に密集する近接戦闘訓練、
  // ステージ1は自機軌道の近傍、ステージ2は低軌道 2 機 + モルニヤ級高楕円軌道 3 機。
  makeEnemySpecs(base: OrbitState, stage: number): EnemySpec[] {
    const r0 = len(base.r);
    const hHat = norm(cross(base.r, base.v));

    if (stage === -1) return []; // ステージ00は初期敵なしで動的スポーンする
    if (stage === 0) return this.makeStage0Specs(base, hHat);

    const phased = (dAlong: number): OrbitState => {
      const ang = dAlong / r0;
      return {
        r: rotateAxis(base.r, hHat, ang),
        v: rotateAxis(base.v, hHat, ang),
      };
    };

    if (stage === 2) {
      // モルニヤ軌道: 近地点 1,200km / 遠地点 39,400km, i=63.4°(近地点引数が歳差しない臨界傾斜),
      // ω=-90°(遠地点が北半球上空)。RAAN と位相を散らして配置。
      const molniya = (raan: number, nu: number, name: string, accent: number): EnemySpec => {
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
      };
      const beta = phased(-2600);
      const betaAlt = r0 + 3000;
      beta.r = scale(norm(beta.r), betaAlt);
      beta.v = scale(norm(beta.v), Math.sqrt(MU_EARTH / betaAlt));
      return [
        { name: 'HOSTILE-α', state: phased(1800), hp: 2, accent: 0xff4a3d },
        { name: 'HOSTILE-β', state: beta, hp: 2, accent: 0xff7a2d },
        molniya(0.4, 2.6, 'MOLNIYA-γ', 0xe0409f),
        molniya(2.5, 0.9, 'MOLNIYA-δ', 0xbf3dff),
        molniya(4.6, 3.8, 'MOLNIYA-ε', 0xff2d6b),
      ];
    }

    // β: コエリプティック(少し高い円軌道)
    const beta = phased(-2800);
    const betaAlt = r0 + 2500;
    beta.r = scale(norm(beta.r), betaAlt);
    beta.v = scale(norm(beta.v), Math.sqrt(MU_EARTH / betaAlt));

    // γ: 相対傾斜 0.4° の交差軌道
    const gamma = phased(2200);
    gamma.v = rotateAxis(gamma.v, norm(gamma.r), (0.4 * Math.PI) / 180);

    // δ: 楕円軌道(遠地点が高く、毎周期近傍へ戻る)
    const delta = phased(5000);
    delta.v = scale(delta.v, 1.006);

    return [
      { name: 'HOSTILE-α', state: phased(1400), hp: 2, accent: 0xff4a3d },
      { name: 'HOSTILE-β', state: beta, hp: 2, accent: 0xff7a2d },
      { name: 'HOSTILE-γ', state: gamma, hp: 2, accent: 0xe0409f },
      { name: 'HOSTILE-δ', state: delta, hp: 3, accent: 0xbf3dff },
      { name: 'HOSTILE-ε', state: phased(60000), hp: 3, accent: 0xff2d6b },
    ];
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
        `撃墜 ${ctx.kills} / ${ctx.enemies.length} 機<br>` +
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

    if (this.stage00Phase === 'waiting_for_ammo') {
      if (ctx.magsLeft > 0 || ctx.roundsInMag > 0) {
        this.stage00Phase = 'spawning_enemies';
        this.stage00SpawnTimer = C.STAGE00_SPAWN_DELAY;
        this.hud.toast('弾薬を確保した。敵部隊が接近中...', 3000);
      }
    } else if (this.stage00Phase === 'spawning_enemies') {
      this.stage00SpawnTimer -= dt;
      if (this.stage00SpawnTimer <= 0) {
        this.spawnStage00Wave(ctx);
        this.stage00Phase = 'active_combat';
        this.stage00SpawnTimer = C.STAGE00_SPAWN_INTERVAL;
      }
    } else if (this.stage00Phase === 'active_combat') {
      // 遠距離の敵をデスポーン(配列からはcleanupで消えるが、alive=falseにして消去)
      for (let i = 0; i < ctx.enemies.length; i++) {
        const e = ctx.enemies[i]!;
        if (!e.alive) continue;
        const dist = len(sub(e.state.r, ctx.player.state.r));
        if (dist > C.STAGE00_MAX_RANGE) {
          e.alive = false;
          ctx.scene.remove(e.obj);
          ctx.enemyOrbitLines[i]?.update(null, v3());
        }
      }

      const activeWaves = new Set<number>();
      for (const e of ctx.enemies) {
        if (e.alive && e.waveId !== undefined) activeWaves.add(e.waveId);
      }
      const activeGroups = activeWaves.size;

      let maxGroups = 1;
      let allowedMaxWaveCount = 2;

      if (this.stage00WaveCount >= 4) {
        if (this.stage00WaveCount >= 5 || activeGroups === 0) {
          maxGroups = 3;
          allowedMaxWaveCount = Infinity; // 第三段階: 同時3つまで無限波状攻撃
        } else {
          maxGroups = 2;
          allowedMaxWaveCount = 4; // まだ第二段階(W3, W4がデスポーンするのを待つ)
        }
      } else if (this.stage00WaveCount >= 2) {
        if (this.stage00WaveCount >= 3 || activeGroups === 0) {
          maxGroups = 2;
          allowedMaxWaveCount = 4; // 第二段階: 同時2つまで (W3, W4)
        } else {
          maxGroups = 1;
          allowedMaxWaveCount = 2; // まだ第一段階(W1, W2がデスポーンするのを待つ)
        }
      }

      if (activeGroups === 0) {
        // 敵集団が場にいない場合は即座にスポーン
        this.stage00SpawnTimer = 0;
      }

      if (activeGroups < maxGroups && this.stage00WaveCount < allowedMaxWaveCount) {
        this.stage00SpawnTimer -= dt;
        if (this.stage00SpawnTimer <= 0) {
          this.spawnStage00Wave(ctx);
          this.stage00SpawnTimer = C.STAGE00_SPAWN_INTERVAL;
          this.hud.toast(`波状攻撃 第${this.stage00WaveCount}波 接近中！`, 3000);
        }
      }
    }
  }

  spawnStage00Wave(ctx: StageCtx, forcedPattern?: 'linear' | 'random'): void {
    this.stage00WaveCount++;
    const w = this.stage00WaveCount;
    const shipCount = C.STAGE00_WAVE_BASE_SHIPS + Math.floor((w - 1) * C.STAGE00_WAVE_SHIPS_PER_WAVE); // 5, 7, 9...

    const types = ['behind', 'front', 'above', 'side'];
    const type = w === 1 ? 'behind' : types[Math.floor(Math.random() * types.length)];

    const dist = C.STAGE00_SPAWN_DIST_MIN + Math.random() * (C.STAGE00_SPAWN_DIST_MAX - C.STAGE00_SPAWN_DIST_MIN);
    const r0 = ctx.player.state.r;
    const v0 = ctx.player.state.v;
    const hHat = norm(cross(r0, v0));
    const rHat = norm(r0);
    const vHat = cross(hHat, rHat);

    let centerR: Vec3;

    // 配置位置を決定 (少しランダムなオフセットもつける)
    const dr = (Math.random() - 0.5) * C.STAGE00_PLACEMENT_JITTER;
    if (type === 'behind') {
      centerR = add(r0, add(scale(vHat, -dist), scale(rHat, dr)));
    } else if (type === 'front') {
      centerR = add(r0, add(scale(vHat, dist), scale(rHat, dr)));
    } else if (type === 'above') {
      centerR = add(r0, add(scale(rHat, dist), scale(vHat, dr)));
    } else { // side
      const sideSign = Math.random() < 0.5 ? 1 : -1;
      centerR = add(r0, add(scale(hHat, dist * sideSign), scale(rHat, dr)));
    }

    // 自機に向かう相対速度成分(フライパス用)
    // 1000m ~ 2000m の範囲ですれ違うようにターゲット位置をずらす
    const missDist = C.STAGE00_FLYBY_MISS_DIST_MIN + Math.random() * C.STAGE00_FLYBY_MISS_DIST_RANGE;
    const directDir = norm(sub(r0, centerR));
    const missPerp = randPerp(directDir);
    const targetPos = add(r0, scale(missPerp, missDist));

    const approachDir = norm(sub(targetPos, centerR));
    const flybySpeed = C.STAGE00_FLYBY_SPEED + (w - 1) * C.STAGE00_FLYBY_SPEED_RAMP; // ウェーブが進むと少し速くなる
    // 敵の初速度 = 自機の速度 + 接近速度 + わずかな横ブレ
    const perpDir = randPerp(approachDir);
    const spread = scale(perpDir, Math.random() * C.STAGE00_FLYBY_LATERAL_SPREAD);
    const centerV = add(v0, add(scale(approachDir, flybySpeed), spread));

    const randCol = Math.random();
    let baseHex: number;
    if (randCol < 0.7) {
      // アースカラー (7割)
      const earthColors = [0xc2b280, 0x808080, 0xb2beb5, 0x8b4513, 0xc3b091, 0x556b2f, 0x8f9779, 0x5f9ea0];
      baseHex = earthColors[Math.floor(Math.random() * earthColors.length)]!;
    } else if (randCol < 0.9) {
      // 寒色系 (2割)
      const coolColors = [0x722f37, 0x8a2be2, 0x0000ff, 0x00ffff, 0x40e0d0, 0x008000, 0x9acd32];
      baseHex = coolColors[Math.floor(Math.random() * coolColors.length)]!;
    } else {
      // アクセントカラー (1割)
      const accentColors = [0xffa500, 0xffc0cb, 0xff0000, 0xffffff];
      baseHex = accentColors[Math.floor(Math.random() * accentColors.length)]!;
    }

    const baseColor = new THREE.Color(baseHex);
    const hsl = { h: 0, s: 0, l: 0 };
    baseColor.getHSL(hsl);

    // 個体を2~4のサブグループに分け、色相・彩度・明度をわずかにずらす
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

    const typeIndex = Math.floor(Math.random() * 3);
    const pattern = forcedPattern || (Math.random() < 0.5 ? 'linear' : 'random');

    for (let i = 0; i < shipCount; i++) {
      const accent = subGroups[i % subGroupCount]!;
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
      const r = add(pos, scale(norm(pos), altDrop));

      const ship: Ship = {
        name: `W${w}-${i + 1}`,
        state: { r, v: clone(centerV) },
        prevR: clone(r),
        att: {
          q: randomQuat(),
          w: v3(0, 0, 0),
          inertia: v3(1, 1, 1),
        },
        obj: buildStage0EnemyShip(accent, typeIndex),
        radius: C.ENEMY_RADIUS,
        hp: C.STAGE0_ENEMY_HP,
        maxHp: C.STAGE0_ENEMY_HP,
        alive: true,
        accent,
        waveId: w,
      };
      ship.obj.scale.setScalar(C.ENEMY_SCALE);

      const zAxis = norm(ship.state.v);
      const yAxis = norm(ship.state.r);
      const xAxis = cross(yAxis, zAxis);
      const m = new THREE.Matrix4().makeBasis(
        new THREE.Vector3(xAxis.x, xAxis.y, xAxis.z),
        new THREE.Vector3(yAxis.x, yAxis.y, yAxis.z),
        new THREE.Vector3(zAxis.x, zAxis.y, zAxis.z),
      );
      const tmpQ = new THREE.Quaternion().setFromRotationMatrix(m);
      ship.att.q = { x: tmpQ.x, y: tmpQ.y, z: tmpQ.z, w: tmpQ.w };

      ctx.enemies.push(ship);
      ctx.scene.add(ship.obj);

      const ol = new OrbitLine(accent, 0.35);
      ctx.enemyOrbitLines.push(ol);
      ctx.scene.add(ol.line);
    }
  }
}
