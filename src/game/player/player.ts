import * as THREE from 'three/webgpu';
import { Attitude, qFromForwardUp } from '../../physics/attitude';
import { ExtraAccel, MU_EARTH, OrbitState, R_EARTH } from '../../physics/orbital';
import { Vec3, v3 } from '../../physics/vec3';
import * as C from '../const';
import { Ship } from '../orbit-entity/entities';
import { Bullet } from '../orbit-entity/bullet';
import { Input } from '../input';
import { Hud } from '../../hud/hud';
import { Sfx } from '../../audio/sfx';
import { buildPlayerShip } from '../../render/ships';
import { OrbitLine } from '../../render/orbitline';
import type { CameraSystem } from '../camera/camera-system';
import { CombatCtx } from '../stages/stage';
import { ScoreCounter } from '../stages/stage-utils/score-counter';
import { PlayerThrottle } from './player-throttle';
import { PlayerFire } from './player-fire';
import { Belt } from './belt';
import { altitudeOf } from '../../physics/orbital';
import { ThermalSystem } from './thermal';
import { CheckLossCtx } from '../orbit-entity/entities';
import { EffectsSystem } from '../effects-system';
import { ThrustEffects } from './thrust-effects';
import { RcsEffects } from './rcs-effects';

export interface PlayerActionState {
  thrustFn: ExtraAccel | null;
}

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

  // hud は現状 Player 自身のメソッドからは未使用だが、hud/sfx は必ず対で注入する方針のため
  // 受け取る(hud はフィールドとしては保持しない)。
  private readonly _sfx: Sfx;
  // 発射キー解放の立ち下がりで姿勢微調整モードを解除するための、直前フレームの発射状態。
  private prevFiring = false;

  // 高度420km・傾斜51.6°の円軌道に機首プログレードで初期配置する
  constructor(hud: Hud, sfx: Sfx, scene: THREE.Scene) {
    const state = Player.makeInitialState();
    super('PLAYER', state, buildPlayerShip(), Player.progradeAttitude(state), C.PLAYER_RADIUS, C.PLAYER_MAX_HP, scene);
    this._sfx = sfx;
    this.mass = 1000;
    // 剛体接触は実機体サイズ。被弾判定半径(radius)を使うと排莢直後の薬莢を弾いてしまう
    this.collideRadius = C.PLAYER_HULL_RADIUS;

    this.throttle = new PlayerThrottle(hud, sfx);
    this.fire = new PlayerFire(hud, sfx, scene);
    this.belt = new Belt(this.obj);
    this.thermal = new ThermalSystem(hud, sfx);
    this.thrustEffects = new ThrustEffects(scene);
    this.rcsEffects = new RcsEffects(scene);

    scene.add(this.orbitLine.line);
  }

  private static makeInitialState(): OrbitState {
    const r0 = R_EARTH + C.INITIAL_ALT;
    const vCirc = Math.sqrt(MU_EARTH / r0);
    const inc = (C.INITIAL_INC_DEG * Math.PI) / 180;
    return {
      r: v3(r0, 0, 0),
      v: v3(0, vCirc * Math.sin(inc), -vCirc * Math.cos(inc)),
    };
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
  get fineAttitude(): boolean { return this.throttle.fineAttitude; }
  get progradeHold(): boolean { return this.throttle.progradeHold; }
  get thrustVizDir(): Vec3 | null { return this.throttle.thrustVizDir; }

  get roundsInMag(): number { return this.fire.roundsInMag; }
  get magsLeft(): number { return this.fire.magsLeft; }
  get magsLeftInBarrel(): number { return this.fire.magsLeftInBarrel; }
  get reloadTimer(): number { return this.fire.reloadTimer; }
  get isFiring(): boolean { return this.fire.isFiring; }

  initAmmo(magsLeft: number, roundsInMag: number): void {
    this.fire.initAmmo(magsLeft, roundsInMag);
  }

  onPickup(mags: number): void {
    this.fire.onPickup(mags);
  }

  update(dt: number): void {
    this.belt.update(dt, this.fire.magsLeft, this.fire.roundsInMag, this.att, this.throttle.thrustAccelVec);
  }

  // 毎フレームの HP 自然回復と、ユーザー入力に対する移動/発射の試行を一括で行う。
  // 実際の移動加速度の組み立ては PlayerThrottle、発砲・排莢の発注は PlayerFire が持つ。
  // canPlayerThrust/canPlayerFire(ワープ倍率による可否)は SimSpeedManager が既に
  // 判定した結果を受け取る — ここで simSpeed 値そのものを見ない。
  // マップモード中は移動/発射の入力そのものを行わない(装填だけは実時間で進行する
  // — behaveMapMode 参照)ため、通常時とは別関数に分ける。
  behave(params: {
    dt: number;
    input: Input;
    canPlayerThrust: boolean;
    canPlayerFire: boolean;
    mapMode: boolean;
    scoreCounter: ScoreCounter;
    simTime: number;
    zoomActive: boolean;
    fx: EffectsSystem;
    addBullet: (bullet: Bullet) => void;
  }): PlayerActionState {
    const { dt, input, canPlayerThrust, canPlayerFire, mapMode, scoreCounter, simTime, zoomActive, fx, addBullet } = params;
    this.hpRegen(dt);
    if (mapMode) return this.behaveMapMode(dt);
    return this.behaveFlying(dt, input, canPlayerThrust, canPlayerFire, scoreCounter, simTime, zoomActive, fx, addBullet);
  }

  // マップモード中: 移動/発射の入力は無効。装填(リロード)だけは戦闘可否に関わらず
  // 実時間で進行し続けるため、PlayerFire にそれだけを進めさせる。
  private behaveMapMode(dt: number): PlayerActionState {
    this.fire.tickMapMode(dt);
    return { thrustFn: null };
  }

  private behaveFlying(
    dt: number,
    input: Input,
    canPlayerThrust: boolean,
    canPlayerFire: boolean,
    scoreCounter: ScoreCounter,
    simTime: number,
    zoomActive: boolean,
    fx: EffectsSystem,
    addBullet: (bullet: Bullet) => void,
  ): PlayerActionState {
    const canThrust = canPlayerThrust && this.alive;
    const canFire = canPlayerFire && this.alive;
    const justStartedFiring = this.fire.updateFireState(dt, input, this.alive, canFire, this, scoreCounter, simTime, zoomActive, fx, addBullet);
    if (justStartedFiring) this.throttle.fineAttitude = true;
    const thrustFn = this.throttle.updateThrustState(input, canThrust, this.att, this.state);
    return { thrustFn };
  }

  // 押下エッジキーの処理し、担当外のキーを記録
  handleEdgeInput(presses: readonly string[], fx: EffectsSystem): string[] {
    return presses.filter((code) => !this.handleEdgePress(code, fx));
  }

  private handleEdgePress(code: string, fx: EffectsSystem): boolean {
    switch (code) {
      case 'KeyT': this.throttle.toggleRcsDamp(); return true;
      case 'KeyF': this.throttle.enableProgradeReset(); return true;
      case 'KeyV': this.throttle.toggleFineAttitude(); return true;
      case 'KeyC': this.throttle.toggleProgradeHold(); return true;
      case 'Digit1': this.throttle.setThrottlePreset(0); return true;
      case 'Digit2': this.throttle.setThrottlePreset(1); return true;
      case 'Digit3': this.throttle.setThrottlePreset(2); return true;
      case 'KeyR':
        if (this.fire.manualReload()) this.fire.dropBarrel(this, fx);
        return true;
      default: return false;
    }
  }

  // 被弾によるダメージ・致死判定。
  attacked(bullet: Bullet, ctx: CombatCtx): void {
    if (!this.alive) return;

    this.hp -= C.PLAYER_HIT_DAMAGE;
    if (this.hp > 0) {
      this.hitEffect(ctx.fx, bullet);
      return;
    }

    this.alive = false;
    const reason = bullet.shooter === 'player' ? '自弾の被弾により機体を喪失した' : '敵のエネルギー弾により機体を喪失した';
    ctx.activeStage.recordPlayerLost(ctx.setPhase, reason);
    this.destroyEffect(ctx.fx);
  }

  // 熱防御の飽和・空力破壊・大気突入高度の判定(自然死)。
  checkLoss(ctx: CheckLossCtx): void {
    if (!this.alive) return;
    const limit = this.thermal.updateAltitudeAlarm(ctx.dt, this.alive, altitudeOf(this.state.r));

    let reason: string | null = null;
    if (limit === 'heat') reason = '断熱圧縮による加熱で熱防御が飽和し、機体は焼失した';
    else if (limit === 'dynpressure') reason = '動圧が構造限界を超え、機体は空力的に分解した';
    else if (altitudeOf(this.state.r) < C.PLAYER_MIN_ALT) reason = '濃密な大気に突入し機体は分解した';
    if (reason === null) return;

    this.alive = false;
    this.destroyEffect(ctx.fx);
    ctx.activeStage.recordPlayerLost(ctx.setPhase, reason);
  }

  // 被弾時の音・火花・欠片(致死判定に関係なく毎回発生する演出)。
  private hitEffect(fx: EffectsSystem, bullet: Bullet): void {
    this._sfx.hit();
    if (bullet.type === 'plasma') {
      fx.spawnPlasmaFlash(bullet.state.r, this.state.v);
    } else {
      fx.spawnBulletFlash(bullet.state.r, this.state.v);
    }
    fx.scatterFragments(bullet.state.r, this.state.v, C.HIT_FRAG_COUNT, 0x6a7078, C.HIT_FRAG_SIZE_MIN, C.HIT_FRAG_SIZE_MAX, C.HIT_FRAG_SPEED);
  }

  private destroyEffect(fx: EffectsSystem): void {
    this._sfx.explosion();
    fx.spawnShipDestroyEffect(this.state.r, this.state.v, 1, 0x9fd8e8);
  }

  // ポーズ中: 移動/発射の一時状態(推力可視化・射撃継続)を止める。
  pause(): void {
    this.throttle.clearTransientState();
    this.fire.stopFiring();
  }

  // 発射キー解放の立ち下がりで姿勢微調整モードを解除する(発射時は自動でONになるため)。
  updateFineAttitudeFromFiring(): void {
    this.throttle.setFineAttitudeFromFiring(this.prevFiring, this.isFiring);
    this.prevFiring = this.isFiring;
  }

  updateAttitude(
    input: Input,
    mapMode: boolean,
    attDt: number,
    onProgradeHoldReleased: () => void,
  ): void {
    this.throttle.updateAttitude(
      this.att,
      this.state.r,
      this.state.v,
      this.alive,
      input,
      mapMode,
      attDt,
      onProgradeHoldReleased,
    );
  }

  // -------------------------------------------------------- 見た目(メッシュ)同期

  // floating origin のため自機は常にワールド原点(基底 Ship.syncTransform とは signature が
  // 異なる別メソッド — origin ではなくズーム中の可視性を受け取る)。ズーム中(PIP)は本体を隠す。
  sync(
    input: Input,
    camera: CameraSystem,
    phasePlaying: boolean,
    paused: boolean
  ): void {
    this.obj.position.set(0, 0, 0);
    this.obj.quaternion.set(this.att.q.x, this.att.q.y, this.att.q.z, this.att.q.w);
    this.obj.visible = this.alive && !camera.zoomActive;

    this.thrustEffects.sync(this.throttle.thrustVizDir, this.throttle.throttleIdx, this.alive, camera);
    this.rcsEffects.sync(input, this.throttle.rcsDamp, this.att, this.alive, phasePlaying, paused, camera);
    this.belt.sync(this.alive);
  }
}
