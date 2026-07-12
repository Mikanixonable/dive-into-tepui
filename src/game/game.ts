// ゲーム全体のオーケストレーション: エンティティ管理、物理積分、
// 入力 → 推力/トルク変換、衝突判定、勝敗判定、描画同期。
//
// 座標系: ECI (慣性系)、Y軸 = 北極、単位 m / m/s。
// 描画は自機中心のフローティングオリジン(自機が常に (0,0,0))。
import * as THREE from 'three/webgpu';
import {
  Elements,
  ExtraAccel,
  OrbitState,
  R_EARTH,
  MU_EARTH,
  SIDEREAL_DAY,
  elementsFromState,
  stepOrbitRK4,
} from '../physics/orbital';
import {
  Attitude,
  qIdentity,
  qRotate,
  randomQuat,
  stepAttitude,
} from '../physics/attitude';
import {
  Vec3,
  add,
  addScaled,
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
import { Bullet, Casing, DebrisPiece, FlashEffect, Ship } from './entities';
import { Input } from './input';
import { ChaseCamera } from './camera';
import { Hud } from './hud';
import { Sfx } from './audio';
import { GameScene } from '../render/scene';
import { createEarth, Earth } from '../render/earth';
import { createStars, createSun, makeGlowTexture, Sun } from '../render/stars';
import {
  buildBulletMesh,
  buildCasingMesh,
  buildDebrisMesh,
  buildEnemyShip,
  buildFlashMesh,
  buildPlayerShip,
} from '../render/ships';
import { OrbitLine } from '../render/orbitline';

type FrameMode = 'orbital' | 'target';
type GamePhase = 'playing' | 'won' | 'lost';

interface EnemySpec {
  name: string;
  state: OrbitState;
  hp: number;
  accent: number;
}

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const Z_AXIS = new THREE.Vector3(0, 0, 1);

function randSym(amp: number): number {
  return (Math.random() * 2 - 1) * amp;
}

function randVec(amp: number): Vec3 {
  return v3(randSym(amp), randSym(amp), randSym(amp));
}

// fwd に直交するランダム単位ベクトル(散布界用)
function randPerp(fwd: Vec3): Vec3 {
  for (;;) {
    const r = randVec(1);
    const p = sub(r, scale(fwd, dot(r, fwd)));
    if (lenSq(p) > 1e-6) return norm(p);
  }
}

export class Game {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;

  private readonly input: Input;
  private readonly hud = new Hud();
  private readonly sfx = new Sfx();
  private readonly chase = new ChaseCamera();

  private readonly earth: Earth;
  private readonly sun: Sun;

  private readonly player: Ship;
  private readonly enemies: Ship[] = [];
  private bullets: Bullet[] = [];
  private casings: Casing[] = [];
  private debris: DebrisPiece[] = [];
  private effects: FlashEffect[] = [];

  private readonly glowTex: THREE.Texture;
  private readonly playerOrbitLine = new OrbitLine(0x35e0ff, 0.55);
  private readonly targetOrbitLine = new OrbitLine(0xffa04a, 0.5);

  private phase: GamePhase = 'playing';
  private simTime = 0;
  private lastSimDt = 0;
  private warpIdx = 0;
  private paused = false;
  private frameMode: FrameMode = 'orbital';
  private rcsDamp = true;
  private target: Ship | null = null;
  private throttleIdx = C.THROTTLE_DEFAULT_IDX;
  private fineAttitude = false;

  private fireCooldown = 0;
  private shots = 0;
  private hits = 0;
  private kills = 0;
  private hudTimer = 0;
  private listTimer = 0;
  private readonly earthPhase0 = Math.random() * Math.PI * 2;

  constructor(gs: GameScene) {
    this.scene = gs.scene;
    this.camera = gs.camera;
    this.input = new Input(gs.renderer.domElement);
    this.input.onFirstGesture = () => this.sfx.unlock();

    // --- 環境 ---
    this.scene.add(new THREE.AmbientLight(0x8899bb, 0.25));
    this.glowTex = makeGlowTexture();
    this.sun = createSun(this.glowTex);
    this.scene.add(this.sun.mesh);
    const sunLight = new THREE.DirectionalLight(0xfff4e0, 2.2);
    sunLight.position.copy(this.sun.dir).multiplyScalar(1e5);
    this.scene.add(sunLight);
    this.scene.add(createStars());
    this.earth = createEarth();
    this.scene.add(this.earth.group);
    this.scene.add(this.playerOrbitLine.line);
    this.scene.add(this.targetOrbitLine.line);

    // --- 自機: 高度420km・傾斜51.6°の円軌道 ---
    const r0 = R_EARTH + C.INITIAL_ALT;
    const vCirc = Math.sqrt(MU_EARTH / r0);
    const inc = (C.INITIAL_INC_DEG * Math.PI) / 180;
    const playerState: OrbitState = {
      r: v3(r0, 0, 0),
      v: v3(0, vCirc * Math.sin(inc), -vCirc * Math.cos(inc)),
    };
    this.player = {
      name: 'PLAYER',
      state: playerState,
      prevR: clone(playerState.r),
      att: this.progradeAttitude(playerState),
      obj: buildPlayerShip(),
      radius: C.PLAYER_RADIUS,
      hp: 1,
      maxHp: 1,
      alive: true,
    };
    this.scene.add(this.player.obj);

    // --- 敵機配置 ---
    for (const spec of this.makeEnemySpecs(playerState)) {
      const ship: Ship = {
        name: spec.name,
        state: spec.state,
        prevR: clone(spec.state.r),
        att: {
          q: randomQuat(),
          w: v3(randSym(0.12), randSym(0.12), randSym(0.12)),
          inertia: v3(1, 1.1, 1.05),
        },
        obj: buildEnemyShip(spec.accent),
        radius: C.ENEMY_RADIUS,
        hp: spec.hp,
        maxHp: spec.hp,
        alive: true,
      };
      this.enemies.push(ship);
      this.scene.add(ship.obj);
    }
    this.retargetNearest();

    this.hud.toast(
      '<b>作戦目標: 敵機 5 機を全機撃破せよ</b><br>' +
        '[Tab] ターゲット選択 → [F] ターゲット基準推進で接近 → [,/.] タイムワープで会合を短縮<br>' +
        '[H] キーで操作方法を表示',
      12000,
    );
  }

  // 機首をプログレード、背を天頂に向けた初期姿勢
  private progradeAttitude(s: OrbitState): Attitude {
    const zAxis = norm(s.v);
    const yAxis = norm(s.r);
    const xAxis = cross(yAxis, zAxis);
    const m = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(xAxis.x, xAxis.y, xAxis.z),
      new THREE.Vector3(yAxis.x, yAxis.y, yAxis.z),
      new THREE.Vector3(zAxis.x, zAxis.y, zAxis.z),
    );
    tmpQ.setFromRotationMatrix(m);
    return {
      q: { x: tmpQ.x, y: tmpQ.y, z: tmpQ.z, w: tmpQ.w },
      w: v3(),
      inertia: v3(1, 1, 1),
    };
  }

  // 自機軌道を基準に位相・高度・傾斜・離心率をずらした敵軌道を作る
  private makeEnemySpecs(base: OrbitState): EnemySpec[] {
    const r0 = len(base.r);
    const hHat = norm(cross(base.r, base.v));

    const phased = (dAlong: number): OrbitState => {
      const ang = dAlong / r0;
      return {
        r: rotateAxis(base.r, hHat, ang),
        v: rotateAxis(base.v, hHat, ang),
      };
    };

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

  // ---------------------------------------------------------------- update

  update(dtRaw: number): void {
    const dt = Math.min(dtRaw, 0.1);
    this.handleEdgeInput();
    if (!this.paused && this.phase === 'playing') {
      this.simulate(dt);
    } else {
      this.lastSimDt = 0;
      this.sfx.setThrust(false);
    }
    if (this.phase !== 'playing') {
      // 撃破後もデブリ等は流し続ける(演出)
      this.coastWorld(dt);
    }
    this.syncRender(dt);
  }

  private warp(): number {
    return C.WARP_LEVELS[this.warpIdx]!;
  }

  private handleEdgeInput(): void {
    for (const code of this.input.takePresses()) {
      switch (code) {
        case 'Tab':
          this.cycleTarget();
          break;
        case 'KeyF':
          if (this.target) {
            this.frameMode = this.frameMode === 'orbital' ? 'target' : 'orbital';
            this.hud.hint(
              this.frameMode === 'orbital' ? '推進基準: 軌道 (ORBIT)' : '推進基準: ターゲット (TARGET)',
            );
          } else {
            this.hud.hint('ターゲットがありません ([Tab] で選択)');
          }
          break;
        case 'KeyT':
          this.rcsDamp = !this.rcsDamp;
          this.hud.hint(`RCS 回転制動: ${this.rcsDamp ? 'ON' : 'OFF'}`);
          break;
        case 'KeyV':
          this.fineAttitude = !this.fineAttitude;
          this.hud.hint(`姿勢微調整モード: ${this.fineAttitude ? 'ON' : 'OFF'}`);
          break;
        case 'Digit1':
        case 'Digit2':
        case 'Digit3': {
          const idx = Number(code[code.length - 1]) - 1;
          this.throttleIdx = idx;
          this.hud.hint(`エンジン出力: 第${idx + 1}段 (${C.THROTTLE_LEVELS[idx]!.toFixed(1)} m/s²)`);
          break;
        }
        case 'Comma':
          if (this.warpIdx > 0) {
            this.warpIdx--;
            this.sfx.warp();
            this.hud.hint(`TIME WARP ×${this.warp()}`);
          }
          break;
        case 'Period':
          if (this.warpIdx < C.WARP_LEVELS.length - 1) {
            this.warpIdx++;
            this.sfx.warp();
            this.hud.hint(`TIME WARP ×${this.warp()}`);
          }
          break;
        case 'KeyP':
          this.paused = !this.paused;
          break;
        case 'KeyH':
          this.hud.toggleHelp();
          break;
        case 'KeyR':
          if (this.phase !== 'playing') location.reload();
          break;
      }
    }
  }

  private cycleTarget(): void {
    const alive = this.enemies
      .filter((e) => e.alive)
      .sort((a, b) => lenSq(sub(a.state.r, this.player.state.r)) - lenSq(sub(b.state.r, this.player.state.r)));
    if (alive.length === 0) return;
    const idx = this.target ? alive.indexOf(this.target) : -1;
    this.target = alive[(idx + 1) % alive.length]!;
    this.hud.hint(`ターゲット: ${this.target.name}`);
  }

  private retargetNearest(): void {
    const alive = this.enemies.filter((e) => e.alive);
    if (alive.length === 0) {
      this.target = null;
      return;
    }
    alive.sort(
      (a, b) => lenSq(sub(a.state.r, this.player.state.r)) - lenSq(sub(b.state.r, this.player.state.r)),
    );
    this.target = alive[0]!;
  }

  // ------------------------------------------------------------- simulate

  private simulate(dt: number): void {
    const warp = this.warp();
    const simDt = dt * warp;
    const canAct = warp <= C.MAX_PHYS_WARP && this.player.alive;

    // 射撃(実時間ベースの連射間隔)
    this.fireCooldown -= dt;
    const wantFire = this.input.down('Space') || this.input.mouseFiring;
    if (wantFire && this.player.alive) {
      if (warp > C.MAX_PHYS_WARP) {
        this.hud.hint(`射撃・推進はワープ ×${C.MAX_PHYS_WARP} 以下でのみ可能`);
      } else if (this.fireCooldown <= 0) {
        this.fireGun();
        this.fireCooldown = C.FIRE_INTERVAL;
      }
    }

    // 推進入力
    const thrustFn = canAct ? this.buildThrustAccel() : null;
    if (!canAct && this.anyThrustKey() && this.player.alive) {
      this.hud.hint(`射撃・推進はワープ ×${C.MAX_PHYS_WARP} 以下でのみ可能`);
    }
    this.sfx.setThrust(thrustFn !== null);

    // 軌道積分(高ワープ時はサブステップ分割)
    const nSub = warp <= C.MAX_PHYS_WARP ? 1 : Math.min(64, Math.ceil(simDt / 20));
    const sub = simDt / nSub;
    for (let i = 0; i < nSub; i++) {
      this.player.prevR = clone(this.player.state.r);
      if (this.player.alive) {
        stepOrbitRK4(this.player.state, sub, thrustFn ?? undefined);
      }
      for (const e of this.enemies) {
        if (!e.alive) continue;
        e.prevR = clone(e.state.r);
        stepOrbitRK4(e.state, sub);
      }
      for (const b of this.bullets) {
        if (!b.alive) continue;
        b.prevR = clone(b.state.r);
        stepOrbitRK4(b.state, sub);
      }
      for (const cs of this.casings) stepOrbitRK4(cs.state, sub);
      for (const d of this.debris) stepOrbitRK4(d.state, sub);
      this.simTime += sub;
      this.checkBulletHits();
    }
    this.lastSimDt = simDt;

    // 姿勢力学(高ワープ時は見かけ上スローになるが数値的に安定)
    const attDt = Math.min(simDt, 0.12);
    this.updatePlayerAttitude(attDt);
    for (const e of this.enemies) if (e.alive) stepAttitude(e.att, v3(), attDt);
    for (const cs of this.casings) stepAttitude(cs.att, v3(), attDt);
    for (const d of this.debris) stepAttitude(d.att, v3(), attDt);

    this.cleanup();
  }

  // 勝敗確定後もデブリ・薬莢・弾を漂わせる
  private coastWorld(dt: number): void {
    const simDt = dt * Math.min(this.warp(), 4);
    for (const b of this.bullets) if (b.alive) stepOrbitRK4(b.state, simDt);
    for (const cs of this.casings) stepOrbitRK4(cs.state, simDt);
    for (const d of this.debris) stepOrbitRK4(d.state, simDt);
    for (const e of this.enemies) if (e.alive) stepOrbitRK4(e.state, simDt);
    const attDt = Math.min(simDt, 0.12);
    for (const cs of this.casings) stepAttitude(cs.att, v3(), attDt);
    for (const d of this.debris) stepAttitude(d.att, v3(), attDt);
    this.simTime += simDt;
    this.lastSimDt = simDt;
  }

  private anyThrustKey(): boolean {
    return ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyE'].some((k) => this.input.down(k));
  }

  // 押下キーから推力加速度関数を構築。RK4 の各ステージで
  // その時点の r, v から基準ベクトルを再評価する。
  private buildThrustAccel(): ExtraAccel | null {
    const i = this.input;
    const ax1 = (i.down('KeyW') ? 1 : 0) + (i.down('KeyS') ? -1 : 0); // プログレード / 接近
    const ax2 = (i.down('KeyA') ? 1 : 0) + (i.down('KeyD') ? -1 : 0); // ノーマル / 左右
    const ax3 = (i.down('KeyE') ? 1 : 0) + (i.down('KeyQ') ? -1 : 0); // ラジアルアウト / 上下
    if (ax1 === 0 && ax2 === 0 && ax3 === 0) return null;

    const mode = this.frameMode;
    const tR = this.target && this.target.alive ? this.target.state.r : null;
    const thrustAccel = C.THROTTLE_LEVELS[this.throttleIdx]!;

    return (r: Vec3, v: Vec3): Vec3 => {
      let d1: Vec3;
      let d2: Vec3;
      let d3: Vec3;
      if (mode === 'target' && tR) {
        const los = norm(sub(tR, r)); // 視線方向
        let ref = norm(cross(r, v));
        if (Math.abs(dot(los, ref)) > 0.95) ref = norm(r);
        const side = norm(cross(los, ref));
        const up = cross(side, los);
        d1 = los;
        d2 = side;
        d3 = up;
      } else {
        const pro = norm(v);
        const h = norm(cross(r, v));
        const radOut = cross(pro, h); // 速度・法線と直交する「外向き」
        d1 = pro;
        d2 = h;
        d3 = radOut;
      }
      return v3(
        (d1.x * ax1 + d2.x * ax2 + d3.x * ax3) * thrustAccel,
        (d1.y * ax1 + d2.y * ax2 + d3.y * ax3) * thrustAccel,
        (d1.z * ax1 + d2.z * ax2 + d3.z * ax3) * thrustAccel,
      );
    };
  }

  private updatePlayerAttitude(attDt: number): void {
    if (!this.player.alive) return;
    const i = this.input;
    const att = this.player.att;
    const I = att.inertia;
    // 機体軸: +X 右, +Y 上, +Z 前(機首)
    const inX = (i.down('KeyI') ? 1 : 0) + (i.down('KeyK') ? -1 : 0); // ピッチ
    const inY = (i.down('KeyL') ? 1 : 0) + (i.down('KeyJ') ? -1 : 0); // ヨー
    const inZ = (i.down('KeyU') ? 1 : 0) + (i.down('KeyO') ? -1 : 0); // ロール

    // 微調整モード: 角加速度・角速度上限を絞り、小刻みな姿勢操作を可能にする
    const angScale = this.fineAttitude ? C.FINE_ATTITUDE_SCALE : 1;
    const maxAngAccel = C.MAX_ANG_ACCEL * angScale;
    const maxAngVel = C.MAX_ANG_VEL * angScale;

    const tq = v3(
      inX * maxAngAccel * I.x,
      inY * maxAngAccel * I.y,
      inZ * maxAngAccel * I.z,
    );
    if (this.rcsDamp) {
      // 入力のない軸のみ制動(手動操作を妨げない)
      if (inX === 0) tq.x -= C.RCS_DAMP_RATE * I.x * att.w.x;
      if (inY === 0) tq.y -= C.RCS_DAMP_RATE * I.y * att.w.y;
      if (inZ === 0) tq.z -= C.RCS_DAMP_RATE * I.z * att.w.z;
    }
    stepAttitude(att, tq, attDt);

    const wMag = len(att.w);
    if (wMag > maxAngVel) {
      att.w = scale(att.w, maxAngVel / wMag);
    }
  }

  // ------------------------------------------------------------ weapons

  private fireGun(): void {
    const p = this.player;
    const fwd = qRotate(p.att.q, v3(0, 0, 1));
    const right = qRotate(p.att.q, v3(1, 0, 0));
    const up = qRotate(p.att.q, v3(0, 1, 0));

    // 弾丸: 機首方向 + 散布界
    const dir = norm(addScaled(fwd, randPerp(fwd), Math.abs(randSym(C.BULLET_SPREAD))));
    const bullet: Bullet = {
      state: {
        r: addScaled(clone(p.state.r), fwd, 8),
        v: addScaled(clone(p.state.v), dir, C.MUZZLE_SPEED),
      },
      prevR: v3(),
      bornSim: this.simTime,
      obj: buildBulletMesh(),
      alive: true,
    };
    bullet.prevR = clone(bullet.state.r);
    this.bullets.push(bullet);
    this.scene.add(bullet.obj);
    if (this.bullets.length > C.MAX_BULLETS) {
      const old = this.bullets.shift()!;
      this.scene.remove(old.obj);
    }

    // 反動(運動量保存の風味): 発射方向と逆に微小 Δv
    p.state.v = addScaled(p.state.v, fwd, -C.RECOIL_DV);

    // 薬莢: 右舷へ排出、激しくタンブリング
    const casing: Casing = {
      state: {
        r: add(p.state.r, add(scale(right, 1.4), scale(fwd, 0.8))),
        v: add(
          p.state.v,
          add(scale(right, 2.2 + Math.random() * 1.2), add(scale(up, randSym(0.8)), randVec(0.4))),
        ),
      },
      att: {
        q: randomQuat(),
        w: v3(randSym(12), randSym(12), randSym(12)),
        inertia: v3(1, 0.3, 1), // 円筒: 長軸まわりが小さい
      },
      bornSim: this.simTime,
      obj: buildCasingMesh(),
    };
    this.casings.push(casing);
    this.scene.add(casing.obj);
    if (this.casings.length > C.MAX_CASINGS) {
      const old = this.casings.shift()!;
      this.scene.remove(old.obj);
    }

    // マズルフラッシュ
    this.spawnFlash(addScaled(clone(p.state.r), fwd, 9), clone(p.state.v), 2.5, 7, 0.07, 0xfff0b8);

    this.shots++;
    this.sfx.fire();
  }

  // サブステップ間の相対運動を線分 vs 球でチェック(高速弾のトンネリング防止)
  private checkBulletHits(): void {
    for (const b of this.bullets) {
      if (!b.alive) continue;
      for (const ship of this.enemies) {
        if (!ship.alive) continue;
        if (this.segmentHit(b, ship)) {
          this.applyHit(b, ship);
          break;
        }
      }
      if (!b.alive) continue;
      // 自機被弾(軌道を一周して戻ってきた自弾)
      if (
        this.player.alive &&
        this.simTime - b.bornSim > C.SELF_HIT_GRACE &&
        this.segmentHit(b, this.player)
      ) {
        this.applyHit(b, this.player);
      }
    }
  }

  private segmentHit(b: Bullet, ship: Ship): boolean {
    const a = sub(b.prevR, ship.prevR);
    const bb = sub(b.state.r, ship.state.r);
    const d = sub(bb, a);
    const dd = lenSq(d);
    const t = dd > 1e-9 ? Math.max(0, Math.min(1, -dot(a, d) / dd)) : 0;
    const closest = addScaled(a, d, t);
    return lenSq(closest) <= ship.radius * ship.radius;
  }

  private applyHit(b: Bullet, ship: Ship): void {
    b.alive = false;
    ship.hp--;
    this.hits++;
    this.sfx.hit();
    this.spawnFlash(clone(b.state.r), clone(ship.state.v), 1.5, 6, 0.25, 0xffe2a0);
    if (ship.hp <= 0) {
      this.destroyShip(ship);
    }
  }

  private destroyShip(ship: Ship): void {
    ship.alive = false;
    ship.obj.visible = false;
    this.sfx.explosion();
    this.spawnFlash(clone(ship.state.r), clone(ship.state.v), 10, 110, 1.1, 0xffb36b);
    this.spawnFlash(clone(ship.state.r), clone(ship.state.v), 6, 40, 0.5, 0xfffbe8);
    this.spawnDebris(ship);

    if (ship === this.player) {
      this.phase = 'lost';
      this.sfx.setThrust(false);
      this.hud.showEnd(
        false,
        `大気圏に突入し機体を喪失した<br>撃破 ${this.kills}/${this.enemies.length} 機`,
      );
      return;
    }

    this.kills++;
    this.hud.hint(`${ship.name} 撃破`);
    if (this.target === ship) {
      this.retargetNearest();
    }
    if (this.enemies.every((e) => !e.alive)) {
      this.phase = 'won';
      this.sfx.setThrust(false);
      const acc = this.shots > 0 ? ((this.hits / this.shots) * 100).toFixed(1) : '0.0';
      this.hud.showEnd(
        true,
        `全 ${this.enemies.length} 機撃破<br>` +
          `ミッション時間 T+ ${Math.floor(this.simTime / 3600)}h ${Math.floor((this.simTime % 3600) / 60)}m ${Math.floor(this.simTime % 60)}s<br>` +
          `発射 ${this.shots} 発 / 命中 ${this.hits} 発 (命中率 ${acc}%)`,
      );
    }
  }

  // 撃破デブリ: 非対称な慣性テンソル + 中間軸まわり回転 → ジャニベコフ効果
  private spawnDebris(ship: Ship): void {
    const accent = ship === this.player ? 0x9fd8e8 : 0xff6a4a;
    const count = 9;
    for (let i = 0; i < count; i++) {
      const size = 0.5 + Math.random() * 1.1;
      const piece: DebrisPiece = {
        state: {
          r: add(ship.state.r, randVec(2.5)),
          v: add(ship.state.v, randVec(2.8)),
        },
        att: {
          q: randomQuat(),
          w: v3(randSym(0.25), (1.4 + Math.random() * 1.2) * (Math.random() < 0.5 ? -1 : 1), randSym(0.25)),
          inertia: v3(1, 2.05, 3.0), // 中間軸 = y: ここに主回転を与えると周期的に反転する
        },
        obj: buildDebrisMesh(accent, size),
      };
      this.debris.push(piece);
      this.scene.add(piece.obj);
    }
    while (this.debris.length > C.MAX_DEBRIS) {
      const old = this.debris.shift()!;
      this.removeDebrisObj(old);
    }
  }

  private removeDebrisObj(d: DebrisPiece): void {
    this.scene.remove(d.obj);
    const mesh = d.obj as THREE.Mesh;
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  }

  private spawnFlash(
    pos: Vec3,
    vel: Vec3,
    size0: number,
    size1: number,
    duration: number,
    color: number,
  ): void {
    const mesh = buildFlashMesh(this.glowTex, color);
    const fx: FlashEffect = { mesh, pos, vel, age: 0, duration, size0, size1 };
    this.effects.push(fx);
    this.scene.add(mesh);
  }

  // ------------------------------------------------------------- cleanup

  private altitudeOf(r: Vec3): number {
    return len(r) - R_EARTH;
  }

  private cleanup(): void {
    // 機体の大気圏突入
    if (this.player.alive && this.altitudeOf(this.player.state.r) < C.REENTRY_ALT) {
      this.destroyShip(this.player);
    }
    for (const e of this.enemies) {
      if (e.alive && this.altitudeOf(e.state.r) < C.REENTRY_ALT) {
        this.destroyShip(e);
      }
    }

    this.bullets = this.bullets.filter((b) => {
      const expired =
        !b.alive ||
        this.simTime - b.bornSim > C.BULLET_LIFETIME ||
        this.altitudeOf(b.state.r) < C.DEBRIS_REENTRY_ALT;
      if (expired) this.scene.remove(b.obj);
      return !expired;
    });

    this.casings = this.casings.filter((cs) => {
      const expired =
        this.simTime - cs.bornSim > C.CASING_LIFETIME ||
        this.altitudeOf(cs.state.r) < C.DEBRIS_REENTRY_ALT;
      if (expired) this.scene.remove(cs.obj);
      return !expired;
    });

    this.debris = this.debris.filter((d) => {
      const expired = this.altitudeOf(d.state.r) < C.DEBRIS_REENTRY_ALT;
      if (expired) this.removeDebrisObj(d);
      return !expired;
    });
  }

  // --------------------------------------------------------- render sync

  private syncRender(dt: number): void {
    const o = this.player.state.r; // フローティングオリジン
    const pv = this.player.state.v;

    // 地球・恒星・太陽
    this.earth.group.position.set(-o.x, -o.y, -o.z);
    this.earth.setRotation(this.earthPhase0 + (2 * Math.PI * this.simTime) / SIDEREAL_DAY);

    // カメラ(自機中心、上 = 動径方向)。[Z] 長押しで機首固定の照準ズーム。
    const mouse = this.input.consumeMouse();
    const zoomActive = this.input.down('KeyZ');
    const boreFwd = this.player.alive ? qRotate(this.player.att.q, v3(0, 0, 1)) : null;
    const boreUp = this.player.alive ? qRotate(this.player.att.q, v3(0, 1, 0)) : null;
    this.chase.update(this.camera, mouse, norm(o), norm(pv), zoomActive, dt, boreFwd, boreUp);
    this.camera.updateMatrixWorld();
    this.sun.mesh.quaternion.copy(this.camera.quaternion);

    // 機体(ズーム中は視界を妨げないよう自機を非表示にする)
    this.player.obj.position.set(0, 0, 0);
    this.setObjAttitude(this.player);
    this.player.obj.visible = this.player.alive && !zoomActive;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      e.obj.position.set(e.state.r.x - o.x, e.state.r.y - o.y, e.state.r.z - o.z);
      this.setObjAttitude(e);
    }

    // 弾(自機から見た相対速度方向へ伸ばす)
    for (const b of this.bullets) {
      b.obj.position.set(b.state.r.x - o.x, b.state.r.y - o.y, b.state.r.z - o.z);
      tmpV.set(b.state.v.x - pv.x, b.state.v.y - pv.y, b.state.v.z - pv.z);
      if (tmpV.lengthSq() > 1e-6) {
        tmpQ.setFromUnitVectors(Z_AXIS, tmpV.normalize());
        b.obj.quaternion.copy(tmpQ);
      }
    }

    for (const cs of this.casings) {
      cs.obj.position.set(cs.state.r.x - o.x, cs.state.r.y - o.y, cs.state.r.z - o.z);
      cs.obj.quaternion.set(cs.att.q.x, cs.att.q.y, cs.att.q.z, cs.att.q.w);
    }
    for (const d of this.debris) {
      d.obj.position.set(d.state.r.x - o.x, d.state.r.y - o.y, d.state.r.z - o.z);
      d.obj.quaternion.set(d.att.q.x, d.att.q.y, d.att.q.z, d.att.q.w);
    }

    // エフェクト
    this.effects = this.effects.filter((fx) => {
      fx.age += dt;
      if (fx.age >= fx.duration) {
        this.scene.remove(fx.mesh);
        (fx.mesh.material as THREE.Material).dispose();
        fx.mesh.geometry.dispose();
        return false;
      }
      fx.pos = addScaled(fx.pos, fx.vel, this.lastSimDt);
      const t = fx.age / fx.duration;
      const size = fx.size0 + (fx.size1 - fx.size0) * Math.sqrt(t);
      fx.mesh.position.set(fx.pos.x - o.x, fx.pos.y - o.y, fx.pos.z - o.z);
      fx.mesh.scale.setScalar(size);
      fx.mesh.quaternion.copy(this.camera.quaternion);
      (fx.mesh.material as THREE.MeshBasicMaterial).opacity = 1 - t;
      return true;
    });

    // 軌道線
    const playerEl = elementsFromState(o, pv);
    this.playerOrbitLine.update(this.player.alive ? playerEl : null, o);
    const tgt = this.target && this.target.alive ? this.target : null;
    this.targetOrbitLine.update(tgt ? elementsFromState(tgt.state.r, tgt.state.v) : null, o);

    this.updateMarkers(o, pv, tgt);
    this.updateNodeMarkers(playerEl, tgt, o);
    this.updateHudPanels(dt, playerEl, tgt);
    this.hud.tick();
  }

  private setObjAttitude(s: Ship): void {
    s.obj.quaternion.set(s.att.q.x, s.att.q.y, s.att.q.z, s.att.q.w);
  }

  // rel: 自機基準の相対位置 → スクリーン座標
  private project(rel: Vec3): { x: number; y: number; front: boolean } {
    tmpV2.set(rel.x, rel.y, rel.z).applyMatrix4(this.camera.matrixWorldInverse);
    const front = tmpV2.z < 0;
    tmpV2.applyMatrix4(this.camera.projectionMatrix);
    return {
      x: (tmpV2.x * 0.5 + 0.5) * window.innerWidth,
      y: (-tmpV2.y * 0.5 + 0.5) * window.innerHeight,
      front,
    };
  }

  private updateMarkers(o: Vec3, pv: Vec3, tgt: Ship | null): void {
    // プログレード / レトログレード
    const proDir = norm(pv);
    const pro = this.project(scale(proDir, 5e4));
    this.hud.marker('pro', 'mk-pro', '⊙', pro.x, pro.y, pro.front, 'PRO');
    const ret = this.project(scale(proDir, -5e4));
    this.hud.marker('retro', 'mk-retro', '⊗', ret.x, ret.y, ret.front, 'RET');

    // 機首方向(ボアサイト)
    if (this.player.alive) {
      const fwd = qRotate(this.player.att.q, v3(0, 0, 1));
      const bs = this.project(scale(fwd, 5e4));
      this.hud.marker('bore', 'mk-boresight', '┼', bs.x, bs.y, bs.front);
    } else {
      this.hud.hideMarker('bore');
    }

    // 敵マーカー
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i]!;
      const key = `e${i}`;
      if (!e.alive) {
        this.hud.hideMarker(key);
        continue;
      }
      const rel = sub(e.state.r, o);
      const p = this.project(rel);
      const dist = len(rel);
      const isTgt = e === tgt;
      const label = `${e.name} ${dist >= 1000 ? (dist / 1000).toFixed(1) + 'km' : dist.toFixed(0) + 'm'}`;
      this.hud.marker(key, isTgt ? 'mk-target' : 'mk-enemy', '◇', p.x, p.y, p.front, label);
    }

    // リード(見越し)マーカー: 相対等速近似で弾丸到達時刻を解く
    let leadShown = false;
    if (tgt && this.player.alive) {
      const relP = sub(tgt.state.r, o);
      const relV = sub(tgt.state.v, pv);
      const t = this.solveLeadTime(relP, relV, C.MUZZLE_SPEED);
      if (t !== null && t < 25) {
        const lead = addScaled(relP, relV, t);
        const p = this.project(lead);
        this.hud.marker('lead', 'mk-lead', '✛', p.x, p.y, p.front, 'LEAD');
        leadShown = true;
      }
    }
    if (!leadShown) this.hud.hideMarker('lead');
  }

  // ターゲットの軌道面との交線(相対昇交点・降交点)を自機の軌道上に表示する。
  // 面変更(ノーマル/アンチノーマル)burn を行うべき位置がひと目で分かる。
  private updateNodeMarkers(playerEl: Elements | null, tgt: Ship | null, o: Vec3): void {
    if (!playerEl || !tgt) {
      this.hud.hideMarker('an');
      this.hud.hideMarker('dn');
      return;
    }
    const tgtEl = elementsFromState(tgt.state.r, tgt.state.v);
    const lineDir = tgtEl ? cross(playerEl.hHat, tgtEl.hHat) : null;
    if (!tgtEl || !lineDir || lenSq(lineDir) < 1e-6) {
      // 軌道面がほぼ一致 → 交線が定まらない
      this.hud.hideMarker('an');
      this.hud.hideMarker('dn');
      return;
    }

    const d = norm(lineDir);
    const thAsc = Math.atan2(dot(d, playerEl.qHat), dot(d, playerEl.pHat));
    const rAsc = playerEl.p / (1 + playerEl.e * Math.cos(thAsc));
    const rDesc = playerEl.p / (1 + playerEl.e * Math.cos(thAsc + Math.PI));

    const ascP = this.project(sub(scale(d, rAsc), o));
    const descP = this.project(sub(scale(d, -rDesc), o));
    this.hud.marker('an', 'mk-node', '▲', ascP.x, ascP.y, ascP.front, 'AN');
    this.hud.marker('dn', 'mk-node', '▽', descP.x, descP.y, descP.front, 'DN');
  }

  // |relP + relV t| = s t を満たす最小の正の t
  private solveLeadTime(relP: Vec3, relV: Vec3, s: number): number | null {
    const a = lenSq(relV) - s * s;
    const b = 2 * dot(relP, relV);
    const c = lenSq(relP);
    if (Math.abs(a) < 1e-6) {
      if (Math.abs(b) < 1e-9) return null;
      const t = -c / b;
      return t > 0 ? t : null;
    }
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    const t1 = (-b - sq) / (2 * a);
    const t2 = (-b + sq) / (2 * a);
    let best: number | null = null;
    for (const t of [t1, t2]) {
      if (t > 0 && (best === null || t < best)) best = t;
    }
    return best;
  }

  private updateHudPanels(
    dt: number,
    playerEl: ReturnType<typeof elementsFromState>,
    tgt: Ship | null,
  ): void {
    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.1;
      this.hud.setStats({
        met: this.simTime,
        warpLabel: `×${this.warp()}`,
        paused: this.paused,
        frameMode: this.frameMode,
        rcsDamp: this.rcsDamp,
        throttleIdx: this.throttleIdx,
        fineAttitude: this.fineAttitude,
        alt: this.altitudeOf(this.player.state.r),
        spd: len(this.player.state.v),
        apAlt: playerEl ? playerEl.apAlt : NaN,
        peAlt: playerEl ? playerEl.peAlt : NaN,
        incDeg: playerEl ? playerEl.incDeg : NaN,
        period: playerEl ? playerEl.period : NaN,
        shots: this.shots,
        kills: this.kills,
        total: this.enemies.length,
      });

      if (tgt) {
        const relP = sub(tgt.state.r, this.player.state.r);
        const relV = sub(tgt.state.v, this.player.state.v);
        const dist = len(relP);
        const tgtEl = elementsFromState(tgt.state.r, tgt.state.v);
        const relIncDeg =
          playerEl && tgtEl
            ? (Math.acos(Math.max(-1, Math.min(1, dot(playerEl.hHat, tgtEl.hHat)))) * 180) / Math.PI
            : NaN;
        this.hud.setTarget({
          name: tgt.name,
          dist,
          closing: dist > 1e-6 ? -dot(relP, relV) / dist : 0,
          relSpeed: len(relV),
          hp: tgt.hp,
          maxHp: tgt.maxHp,
          apAlt: tgtEl ? tgtEl.apAlt : NaN,
          peAlt: tgtEl ? tgtEl.peAlt : NaN,
          incDeg: tgtEl ? tgtEl.incDeg : NaN,
          period: tgtEl ? tgtEl.period : NaN,
          relIncDeg,
        });
      } else {
        this.hud.setTarget(null);
      }
    }

    this.listTimer -= dt;
    if (this.listTimer <= 0) {
      this.listTimer = 0.25;
      const rows = this.enemies
        .filter((e) => e.alive)
        .map((e) => ({
          name: e.name,
          dist: len(sub(e.state.r, this.player.state.r)),
          targeted: e === tgt,
        }))
        .sort((a, b) => a.dist - b.dist);
      this.hud.setEnemyList(rows);
    }
  }
}
