import * as THREE from 'three/webgpu';
import { Attitude, qFromForwardUp } from '../../physics/attitude';
import { MU_EARTH, OrbitState, R_EARTH, orbitState } from '../../physics/orbital';
import { Vec3, v3 } from '../../physics/vec3';
import { FloatingOrigin } from '../floating-origin';
import * as C from '../const';
import { Ship } from '../game-entity/ship';
import { Bullet } from '../game-entity/bullet';
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
import { ReentryEffects } from './reentry-effects';
import { PlayerMarkers } from './player-markers';
import { MarkerManager } from '../marker/marker-manager';
import { SimSpeedManager } from '../sim-speed-manager';
import { RadiatorSide, RadiatorSystem } from './radiator';
import { PowerSystem } from './power';
import { Ephemeris, sunlitFactor } from '../../physics/ephemeris';

// プレイヤー機: 移動(PlayerThrottle)と射撃(PlayerFire)を束ね、その両方を反映した
// 見た目(モデル・エフェクトメッシュの管理と毎フレーム更新)を持つ。
export class Player extends Ship {
  readonly throttle: PlayerThrottle;
  readonly fire: PlayerFire;
  readonly belt: Belt;
  readonly thermal: ThermalSystem;
  readonly radiator: RadiatorSystem;
  readonly power: PowerSystem;

  private readonly thrustEffects: ThrustEffects;
  private readonly rcsEffects: RcsEffects;
  private readonly reentryEffects: ReentryEffects;
  private readonly markers: PlayerMarkers;
  // 自機軌道線: 明るいグレー。ターゲット(オレンジ)より目立たせない配色。
  readonly orbitLine = new OrbitLine(0xbfc9d4, 0.55);

  private readonly _hud: Hud;
  private readonly _sfx: Sfx;
  private readonly _fx: EffectsSystem;

  fineAttitude = false;

  // 高度 INITIAL_ALT・傾斜 INITIAL_INC_DEG の円軌道に機首プログレードで初期配置する
  constructor(
    _hud: Hud, _sfx: Sfx, _scene: THREE.Scene, _fx: EffectsSystem, markerManager: MarkerManager) {
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
    this.radiator = new RadiatorSystem(this.obj);
    this.power = new PowerSystem(this.obj);
    this.thrustEffects = new ThrustEffects(_scene);
    this.rcsEffects = new RcsEffects(_scene, _sfx);
    this.reentryEffects = new ReentryEffects(_scene);
    this.markers = new PlayerMarkers(markerManager);

    _scene.add(this.orbitLine.line);
  }

  // 高度 INITIAL_ALT、傾斜角 INITIAL_INC_DEG の円軌道状態を返す。
  private static makeInitialState(): OrbitState {
    const r0 = R_EARTH + C.INITIAL_ALT;
    const vCirc = Math.sqrt(MU_EARTH / r0);
    const inc = (C.INITIAL_INC_DEG * Math.PI) / 180;
    return orbitState(0, v3(r0, 0, 0), v3(0, vCirc * Math.sin(inc), -vCirc * Math.cos(inc)));
  }

  // state の速度方向を機首、位置方向を上として姿勢を組む。
  private static progradeAttitude(state: OrbitState): Attitude {
    return {
      q: qFromForwardUp(state.v, state.r) ?? { x: 0, y: 0, z: 0, w: 1 },
      w: v3(),
      // 3軸を非対称にし、中間軸(ピッチ)周りの回転にジャニベコフ効果(中間軸不安定性)が
      // 起こるようにする。ロール軸(機体前後方向)は細長い形状に見合って最小にする。
      inertia: v3(C.PLAYER_INERTIA_PITCH, C.PLAYER_INERTIA_YAW, C.PLAYER_INERTIA_ROLL),
    };
  }

  // HP を HP_REGEN_RATE で maxHp まで自然回復させる。
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

  // 初期弾数(マグ数・装填ラウンド数)を設定する。
  initAmmo(mags: number, rounds: number): void {
    this.fire.initAmmo(mags, rounds);
  }

  // 弾薬ピックアップで得たマグ数を加算する。
  onPickup(mags: number): void {
    this.fire.onPickup(mags);
  }

  // 毎フレームの HP 自然回復と、ユーザー入力に対する移動/発射の試行を一括で行う。
  behave(params: {
    dt: number;
    input: Input;
    simSpeed: SimSpeedManager;
    editMode: boolean;
    scoreCounter: ScoreCounter;
    simTime: number;
    zoomActive: boolean;
    ephemeris: Ephemeris;
    addBullet: (bullet: Bullet) => void;
  }): void {
    const { dt, input, simSpeed, editMode, scoreCounter, simTime, zoomActive, ephemeris, addBullet } = params;

    this.belt.update(dt, this.fire.mags, this.fire.rounds, this.att, this.throttle.thrustAccelVec);
    this.handleEdgeInput(input);
    this.updateTorque(input, editMode, dt * simSpeed.simSpeed);

    this.radiator.update(dt);
    const sunDir = ephemeris.sunDirAt(simTime);
    const sunlit = sunlitFactor(this.state.r, sunDir, C.SHADOW_PENUMBRA);
    this.thermal.setRadiatorLoad(
      this.radiator.radiatingArea(),
      this.radiator.solarLoad(sunlit, sunDir, this.att),
    );
    this.radius = this.radiator.hitRadius();
    this.power.update(dt, sunlit, sunDir, this.att);

    // 死亡済み: 射撃、移動、hp回復はできない
    if (!this.alive) {
      this.thrust = null;
      return;
    }

    this.hpRegen(dt);

    if (editMode) {
      this.fire.tickMapMode(dt);
      this.thrust = null;
      return;
    }

    this.fire.updateFireState(dt, input, scoreCounter, simTime, simSpeed, zoomActive, addBullet);

    this.thrust = this.throttle.updateThrustState(input, simSpeed, this.att);
    // 推力入力の瞬間に予測を即破棄する — resyncPrediction の距離判定を待つと数フレームの遅延が生じる。
    if (this.thrust !== null) this.invalidatePrediction();
  }

  // 姿勢微調整モードの ON/OFF を切り替える。
  toggleFineAttitude(): void {
    this.fineAttitude = !this.fineAttitude;
    this._hud.hint(`姿勢微調整モード: ${this.fineAttitude ? 'ON' : 'OFF'}`);
  }

  // 自機側のキー(RCS減衰・プログレード・スロットル等)を1フレーム分消費する。
  private handleEdgeInput(input: Input): void {
    input.takeKeys((code) => this.handleEdgePress(code));
  }

  // 自機側キー1個を処理する。処理したキーは true を返し input.takeKeys に消費させる。
  private handleEdgePress(code: string): boolean {
    switch (code) {
      case K.rcsDampToggle.code: this.throttle.toggleRcsDamp(); return true;
      case K.progradeReset.code: this.throttle.enableProgradeReset(); return true;
      case K.fineAttitudeToggle.code: this.toggleFineAttitude(); return true;
      case K.progradeHoldToggle.code: this.throttle.toggleProgradeHold(); return true;
      case K.throttleLow.code: this.throttle.setThrottlePreset(0); return true;
      case K.throttleMid.code: this.throttle.setThrottlePreset(1); return true;
      case K.throttleHigh.code: this.throttle.setThrottlePreset(2); return true;
      case K.radiatorDeployUp.code: this.radiator.toggle('up'); return true;
      case K.radiatorDeployDown.code: this.radiator.toggle('down'); return true;
      case K.solarDeployUp.code: this.power.toggle('up'); return true;
      case K.solarDeployDown.code: this.power.toggle('down'); return true;
      // マニュアルリロードに成功した場合だけキーを消費する
      case K.reload.code: return this.fire.manualReload();
      default: return false;
    }
  }

  // 被弾によるダメージ・致死判定。
  attacked(bullet: Bullet, _simTime: number, activeStage: Stage, hitR: Vec3): void {
    if (!this.alive) return;

    this.thermal.addImpactHeat();
    const brokenSide = this.radiator.damageFromHit(hitR, this.state.r, this.att);
    if (brokenSide !== null) this.radiatorBreakEffect(brokenSide);
    this.hp -= C.PLAYER_HIT_DAMAGE;
    if (this.hp > 0) {
      // 生存していれば被弾エフェクトのみ
      this.hitEffect(bullet, hitR);
      return;
    }

    // HP が尽きたら破壊
    this.alive = false;
    const reason = bullet.shooter === 'player' ? '自弾の被弾により機体を喪失した' : '敵のエネルギー弾により機体を喪失した';
    activeStage.recordPlayerLost(reason);
    this.destroyEffect();
  }

  // 敵機との高速接触によるダメージ・致死判定。speed は接触時の相対速度 [m/s]。
  collidedAtSpeed(speed: number, activeStage: Stage): void {
    if (!this.alive) return;

    if (!this.applyCollisionDamage(speed)) return;
    if (this.hp > 0) {
      this._sfx.clank();
      this._fx.spawnGasPuff(this.state.r, this.state.v);
      return;
    }

    this.alive = false;
    activeStage.recordPlayerLost('敵機との高速接触により機体を喪失した');
    this.destroyEffect();
  }

  // 熱防御の飽和・空力破壊・大気突入高度の判定(自然死)。
  checkLoss(dt: number, _simTime: number, activeStage: Stage, _playerPos: Vec3): void {
    if (!this.alive) return;
    const limit = this.thermal.updateAltitudeAlarm(dt, this.alive, altitudeOf(this.state.r));

    // 熱・動圧・高度いずれかの限界超過を喪失理由として判定する
    let reason: string | null = null;
    if (limit === 'heat-aero') reason = '断熱圧縮による加熱で熱防御が飽和し、機体は焼失した';
    else if (limit === 'heat-internal') reason = '排熱が追いつかず、機体は熱で機能不全に陥った';
    else if (limit === 'dynpressure') reason = '動圧が構造限界を超え、機体は空力的に分解した';
    else if (altitudeOf(this.state.r) < C.PLAYER_MIN_ALT) reason = '濃密な大気に突入し機体は分解した';
    if (reason === null) return;

    this.alive = false;
    this.destroyEffect();
    activeStage.recordPlayerLost(reason);
  }

  // 被弾時の音・火花・欠片(致死判定に関係なく毎回発生する演出)。
  private hitEffect(bullet: Bullet, hitR: Vec3): void {
    this._sfx.hit();
    if (bullet.type === 'plasma') {
      this._fx.spawnPlasmaFlash(hitR, this.state.v);
    } else {
      this._fx.spawnBulletFlash(hitR, this.state.v);
    }
    this._fx.spawnGasPuff(hitR, this.state.v);
  }

  // 機体喪失時の爆発音・爆発エフェクトを発生させる。
  private destroyEffect(): void {
    this._sfx.explosion();
    this._fx.spawnShipDestroyEffect(this.state, 1, C.COLOR_PLAYER_DESTROY_FRAG);
  }

  // ラジエーターが全損した瞬間の破片エフェクトを、そのパネル先端付近から発生させる。
  private radiatorBreakEffect(side: RadiatorSide): void {
    this._sfx.hit();
    const tipR = this.radiator.tipWorldPosition(side, this.state.r, this.att);
    this._fx.scatterFragments(this.state.t, tipR, this.state.v, 4, C.COLOR_PLAYER_DESTROY_FRAG, C.DESTROY_FRAG_SIZE_MIN, C.DESTROY_FRAG_SIZE_MAX, 8.0);
  }

  // ポーズ中: 移動/発射の一時状態(推力可視化・射撃継続)を止める。
  pause(): void {
    this.throttle.clearTransientState();
    this.fire.stopFiring();
  }


  // 入力から機体座標系トルクを求めて this.torque へ反映し、角速度をクランプする。
  private updateTorque(input: Input, editMode: boolean, attDt: number): void {
    // 発砲中は姿勢微調整と同じ操作精度になる
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
  }

  // 自機のメッシュ・エフェクト・ベルト・マーカー・軌道線を displayTime の状態へ同期する。
  syncPlayer(
    fo: FloatingOrigin,
    camera: CameraSystem,
    phasePlaying: boolean,
    paused: boolean,
    displayTime: number,
  ): void {
    // メッシュ本体の位置・姿勢
    const displayState = this.displayState(displayTime);
    this.obj.visible = displayState !== null && this.alive && !camera.zoomActive;
    if (displayState !== null) {
      this.obj.position.copy(fo.RtoThreeV3(displayState.r));
      this.obj.quaternion.set(this.att.q.x, this.att.q.y, this.att.q.z, this.att.q.w);
    }

    // 推力/RCS エフェクトとベルト
    this.thrustEffects.sync(fo, this.state.r, this.throttle.thrustVizDir, this.throttle.throttleIdx, this.alive, camera);
    this.rcsEffects.sync(fo, this.state.r, this.torque, this.att, this.alive, phasePlaying, paused, camera);
    this.reentryEffects.sync(fo, this.state.r, this.state.v, this.thermal.qdyn, this.alive, camera);
    this.belt.sync(this.alive);
    this.radiator.sync();
    this.power.sync();
    // マーカーと軌道線
    this.markers.sync(this.state, displayState, this.att, this.alive, camera.overviewMode, camera.activeCameraProjection);

    this.orbitLine.sync(this.alive ? this.elements : null, fo, this.thrustVizDir !== null, this.state.r);
  }
}
