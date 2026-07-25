import * as THREE from 'three/webgpu';
import { Attitude, qFromForwardUp } from '../../physics/attitude';
import { MU_EARTH, OrbitState, R_EARTH, orbitState } from '../../physics/orbital';
import { Vec3, v3 } from '../../physics/vec3';
import { FloatingOrigin } from '../floating-origin';
import * as C from '../const';
import { Ship } from '../orbit-entity/entities';
import { Bullet } from '../orbit-entity/bullet';
import { Input } from '../input/input';
import { KEY_MAPPING as K } from '../input/key-mapping';
import { Hud } from '../hud/hud';
import { Sfx } from '../../audio/sfx';
import { buildPlayerShip } from '../../render/ships';
import { OrbitLine } from '../../render/orbitline';
import type { CameraSystem } from '../camera/camera-system';
import type { Stage } from '../stages/stage';
import { ScoreCounter } from '../stages/stage-utils/score-counter';
import { PlayerThrottle } from './player-throttle';
import { PlayerFire } from './player-fire';
import { Belt } from './belt';
import { altitudeOf } from '../../physics/orbital';
import { ThermalSystem } from './thermal';
import { EffectsSystem } from '../vfx/effects-system';
import { ThrustEffects } from './thrust-effects';
import { RcsEffects } from './rcs-effects';
import { SimSpeedManager } from '../sim-speed-manager';

// プレイヤー機: 移動(PlayerThrottle)と射撃(PlayerFire)を束ね、その両方を反映した
// 見た目(モデル・エフェクトメッシュの管理と毎フレーム更新)を持つ。
export class Player extends Ship {
  readonly throttle: PlayerThrottle;
  readonly fire: PlayerFire;
  readonly belt: Belt;
  readonly thermal: ThermalSystem;

  private readonly thrustEffects: ThrustEffects;
  private readonly rcsEffects: RcsEffects;
  // 自機軌道線: 明るいグレー。ターゲット(オレンジ)より目立たせない配色。
  readonly orbitLine = new OrbitLine(0xbfc9d4, 0.55);

  private readonly _hud: Hud;
  private readonly _sfx: Sfx;
  private readonly _fx: EffectsSystem;

  // 姿勢角微調整モード　射撃立ち上がりで有効化し、立下りで無効化する
  fineAttitude = false;

  // 高度420km・傾斜51.6°の円軌道に機首プログレードで初期配置する
  constructor(
    _hud: Hud, _sfx: Sfx, _scene: THREE.Scene, _fx: EffectsSystem) {
    const state = Player.makeInitialState();
    super('PLAYER', state, buildPlayerShip(), Player.progradeAttitude(state), C.PLAYER_RADIUS, C.PLAYER_MAX_HP, _scene);
    this._hud = _hud;
    this._sfx = _sfx;
    this._fx = _fx;
    this.mass = 1000;
    // 剛体接触は実機体サイズ。被弾判定半径(radius)を使うと排莢直後の薬莢を弾いてしまう
    this.collideRadius = C.PLAYER_HULL_RADIUS;

    this.throttle = new PlayerThrottle(_hud, _sfx);
    this.fire = new PlayerFire(this, _hud, _sfx, _scene, _fx);
    this.belt = new Belt(this.obj);
    this.thermal = new ThermalSystem(_hud, _sfx);
    this.thrustEffects = new ThrustEffects(_scene);
    this.rcsEffects = new RcsEffects(_scene);

    _scene.add(this.orbitLine.line);
  }

  private static makeInitialState(): OrbitState {
    const r0 = R_EARTH + C.INITIAL_ALT;
    const vCirc = Math.sqrt(MU_EARTH / r0);
    const inc = (C.INITIAL_INC_DEG * Math.PI) / 180;
    return orbitState(0, v3(r0, 0, 0), v3(0, vCirc * Math.sin(inc), -vCirc * Math.cos(inc)));
  }

  private static progradeAttitude(state: OrbitState): Attitude {
    return {
      q: qFromForwardUp(state.v, state.r) ?? { x: 0, y: 0, z: 0, w: 1 },
      w: v3(),
      inertia: v3(1, 1, 1),
    };
  }

  private hpRegen(dt: number): void {
    if (!this.alive || this.hp <= 0 || this.hp >= this.maxHp) return;
    this.hp = Math.min(this.maxHp, this.hp + dt * C.HP_REGEN_RATE);
  }

  // -------------------------------------------------------- 移動/射撃 状態
  get rcsDamp(): boolean { return this.throttle.rcsDamp; }
  get throttleIdx(): number { return this.throttle.throttleIdx; }
  get progradeHold(): boolean { return this.throttle.progradeHold; }
  get thrustVizDir(): Vec3 | null { return this.throttle.thrustVizDir; }

  get roundsInMag(): number { return this.fire.rounds; }
  get magsLeft(): number { return this.fire.mags; }
  get magsLeftInBarrel(): number { return this.fire.barrel; }
  get reloadTimer(): number { return this.fire.cooldown; }
  get isFiring(): boolean { return this.fire.isFiring; }

  initAmmo(mags: number, rounds: number): void {
    this.fire.initAmmo(mags, rounds);
  }

  onPickup(mags: number): void {
    this.fire.onPickup(mags);
  }

  // 毎フレームの HP 自然回復と、ユーザー入力に対する移動/発射の試行を一括で行う。
  // 実際の移動加速度の組み立ては PlayerThrottle、発砲・排莢の発注は PlayerFire が持つ。
  // canPlayerThrust/canPlayerFire(ワープ倍率による可否)は SimSpeedManager が既に
  // 判定した結果を受け取る — ここで simSpeed 値そのものを見ない。
  // 計画編集モード中は移動/発射・手動姿勢制御の入力そのものを行わない(WASDQE などが
  // Δv 編集に振り替わるため)。装填だけは実時間で進行する。
  behave(params: {
    dt: number;
    input: Input;
    simSpeed: SimSpeedManager;
    editMode: boolean;
    scoreCounter: ScoreCounter;
    simTime: number;
    zoomActive: boolean;
    addBullet: (bullet: Bullet) => void;
  }): void {
    const { dt, input, simSpeed, editMode, scoreCounter, simTime, zoomActive, addBullet } = params;

    this.belt.update(dt, this.fire.mags, this.fire.rounds, this.att, this.throttle.thrustAccelVec);
    this.handleEdgeInput(input);
    this.updateTorque(input, editMode, dt * simSpeed.simSpeed);

    // 死亡済み: 射撃、移動、hp回復はできない
    if (!this.alive) {
      this.thrustFn = null;
      return;
    }

    this.hpRegen(dt);

    // 計画編集モード中: 移動/発射の入力は無効。装填(リロード)だけは戦闘可否に関わらず
    // 実時間で進行し続けるため、PlayerFire にそれだけを進めさせる。
    if (editMode) {
      this.fire.tickMapMode(dt);
      this.thrustFn = null;
      return;
    }

    this.fire.updateFireState(dt, input, scoreCounter, simTime, simSpeed, zoomActive, addBullet);

    this.thrustFn = this.throttle.updateThrustState(input, simSpeed, this.att, this.state);
  }

  toggleFineAttitude(): void {
    this.fineAttitude = !this.fineAttitude;
    this._hud.hint(`姿勢微調整モード: ${this.fineAttitude ? 'ON' : 'OFF'}`);
  }

  // 押下エッジキーのうち自機担当分を処理する(処理したキーは input が消費し、
  // 後から受ける側には届かない)。
  private handleEdgeInput(input: Input): void {
    input.takeKeys((code) => this.handleEdgePress(code));
  }

  private handleEdgePress(code: string): boolean {
    switch (code) {
      case K.rcsDampToggle.code: this.throttle.toggleRcsDamp(); return true;
      case K.progradeReset.code: this.throttle.enableProgradeReset(); return true;
      case K.fineAttitudeToggle.code: this.toggleFineAttitude(); return true;
      case K.progradeHoldToggle.code: this.throttle.toggleProgradeHold(); return true;
      case K.throttleLow.code: this.throttle.setThrottlePreset(0); return true;
      case K.throttleMid.code: this.throttle.setThrottlePreset(1); return true;
      case K.throttleHigh.code: this.throttle.setThrottlePreset(2); return true;
      case K.reload.code: return this.fire.manualReload(); // マニュアルリロードに成功した場合のみ、keyを消費する
      default: return false;
    }
  }

  // 被弾によるダメージ・致死判定。
  attacked(bullet: Bullet, _simTime: number, activeStage: Stage): void {
    if (!this.alive) return;

    this.hp -= C.PLAYER_HIT_DAMAGE;
    if (this.hp > 0) {
      this.hitEffect(bullet);
      return;
    }

    this.alive = false;
    const reason = bullet.shooter === 'player' ? '自弾の被弾により機体を喪失した' : '敵のエネルギー弾により機体を喪失した';
    activeStage.recordPlayerLost(reason);
    this.destroyEffect();
  }

  // 熱防御の飽和・空力破壊・大気突入高度の判定(自然死)。
  checkLoss(dt: number, _simTime: number, activeStage: Stage): void {
    if (!this.alive) return;
    const limit = this.thermal.updateAltitudeAlarm(dt, this.alive, altitudeOf(this.state.r));

    let reason: string | null = null;
    if (limit === 'heat') reason = '断熱圧縮による加熱で熱防御が飽和し、機体は焼失した';
    else if (limit === 'dynpressure') reason = '動圧が構造限界を超え、機体は空力的に分解した';
    else if (altitudeOf(this.state.r) < C.PLAYER_MIN_ALT) reason = '濃密な大気に突入し機体は分解した';
    if (reason === null) return;

    this.alive = false;
    this.destroyEffect();
    activeStage.recordPlayerLost(reason);
  }

  // 被弾時の音・火花・欠片(致死判定に関係なく毎回発生する演出)。
  private hitEffect(bullet: Bullet): void {
    this._sfx.hit();
    if (bullet.type === 'plasma') {
      this._fx.spawnPlasmaFlash(bullet.state.r, this.state.v);
    } else {
      this._fx.spawnBulletFlash(bullet.state.r, this.state.v);
    }
    this._fx.scatterFragments(this.state.t, bullet.state.r, this.state.v, C.HIT_FRAG_COUNT, 0x6a7078, C.HIT_FRAG_SIZE_MIN, C.HIT_FRAG_SIZE_MAX, C.HIT_FRAG_SPEED);
  }

  private destroyEffect(): void {
    this._sfx.explosion();
    this._fx.spawnShipDestroyEffect(this.state, 1, 0x9fd8e8);
  }

  // ポーズ中: 移動/発射の一時状態(推力可視化・射撃継続)を止める。
  pause(): void {
    this.throttle.clearTransientState();
    this.fire.stopFiring();
  }


  private updateTorque(input: Input, editMode: boolean, attDt: number): void {
    const fine = this.fineAttitude || this.fire.isFiring;
    this.torque = this.throttle.updateTorque(
      this.att,
      this.state.r,
      this.state.v,
      this.alive,
      input,
      editMode,
      fine,
      attDt,
      () => this._hud.hint('進行方向ホールド解除(手動操作)'),
    );
    this.att = this.throttle.clampAngularVelocity(this.att, fine);
  }

  // 自機も他エンティティと同じく絶対 ECI 位置(state.r)を fo 経由で描画フレームへ変換する
  // (基底 syncTransform とは signature が異なる別メソッド — camera/可視性も受け取る)。
  // ズーム中(PIP)は本体を隠す。機体付随のエフェクト(プルーム/RCSパフ)には fo と自機
  // 状態を渡し、慣性座標で位置を組んでから末端で fo 変換させる。
  // 型シグネチャが異なるため、オーバーライドではなく別メソッドとして定義する。基底クラスのsyncは使わない
  syncPlayer(
    fo: FloatingOrigin,
    camera: CameraSystem,
    phasePlaying: boolean,
    paused: boolean
  ): void {
    this.obj.position.copy(fo.RtoThreeV3(this.state.r));
    this.obj.quaternion.set(this.att.q.x, this.att.q.y, this.att.q.z, this.att.q.w);
    this.obj.visible = this.alive && !camera.zoomActive;

    this.thrustEffects.sync(fo, this.state.r, this.throttle.thrustVizDir, this.throttle.throttleIdx, this.alive, camera);
    this.rcsEffects.sync(fo, this.state.r, this.torque, this.att, this.alive, phasePlaying, paused, camera);
    this.belt.sync(this.alive);

    // 自機軌道線は「高精度で描きたい点」付近の頂点を密にする(focusPos)。本来これは
    // フローティングオリジン(≒カメラ近傍、単精度でも破綻させたくない領域)であるべきだが、
    // fo が微動するたびに軌道線を再生成すると破綻するため、妥協として自機位置を密点に渡す。
    this.orbitLine.sync(this.alive ? this.elements : null, fo, this.thrustVizDir !== null, this.state.r);
  }
}
