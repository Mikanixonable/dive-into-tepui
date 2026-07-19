import * as THREE from 'three/webgpu';
import { Attitude, qFromForwardUp, qRotate, stepAttitude } from '../physics/attitude';
import { ExtraAccel, MU_EARTH, OrbitState, R_EARTH } from '../physics/orbital';
import { Vec3, addScaled, cross, len, lenSq, norm, scale, v3 } from '../physics/vec3';
import * as C from './const';
import { Ship } from './entities';
import { Input } from './input';
import { Hud } from '../hud/hud';
import { Sfx } from '../audio/sfx';
import { buildPlayerShip, RCS_BLOCK_OFFSETS } from '../render/ships';

type AmmoEvent = 'none' | 'mag' | 'reload';

export interface PlayerActionState {
  canAct: boolean;
  thrustFn: ExtraAccel | null;
}

export class Player extends Ship {
  rcsDamp = true;
  throttleIdx = C.THROTTLE_DEFAULT_IDX;
  fineAttitude = false;
  progradeHold = true;
  thrustVizDir: Vec3 | null = null;
  thrustAccelVec: Vec3 = v3();

  private rotationHoldTime = 0;
  private fireCooldown = 0;
  private wasFiring = false;
  private wasEmptyClick = false;
  private roundsInMagValue = C.MAG_ROUNDS;
  private magsLeftValue = C.INITIAL_MAGS - 1;
  private magsConsumedSinceReloadValue = 0;
  private reloadTimerValue = 0;

  // 高度420km・傾斜51.6°の円軌道に機首プログレードで初期配置する
  constructor(
    private readonly hud: Hud,
    private readonly sfx: Sfx,
  ) {
    const state = Player.makeInitialState();
    super('PLAYER', state, buildPlayerShip(), Player.progradeAttitude(state), C.PLAYER_RADIUS, C.PLAYER_MAX_HP);
    this.mass = 1000;
    // 剛体接触は実機体サイズ。被弾判定半径(radius)を使うと排莢直後の薬莢を弾いてしまう
    this.collideRadius = C.PLAYER_HULL_RADIUS;
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

  updateHpRegen(dt: number): void {
    if (!this.alive || this.hp <= 0 || this.hp >= this.maxHp) return;
    this.hp = Math.min(this.maxHp, this.hp + dt * C.HP_REGEN_RATE);
  }

  get roundsInMag(): number { return this.roundsInMagValue; }
  get magsLeft(): number { return this.magsLeftValue; }
  get magsConsumedSinceReload(): number { return this.magsConsumedSinceReloadValue; }
  get reloadTimer(): number { return this.reloadTimerValue; }
  get isFiring(): boolean { return this.wasFiring; }

  initAmmo(magsLeft: number, roundsInMag: number): void {
    this.magsLeftValue = magsLeft;
    this.roundsInMagValue = roundsInMag;
    this.magsConsumedSinceReloadValue = 0;
    this.reloadTimerValue = 0;
    this.wasEmptyClick = false;
    this.fireCooldown = 0;
    this.wasFiring = false;
  }

  hasAmmo(): boolean {
    return this.roundsInMagValue > 0 || this.magsLeftValue > 0;
  }

  canAct(warp: number, mapMode: boolean): boolean {
    return warp <= C.MAX_PHYS_WARP && this.alive && !mapMode;
  }

  updateActionState(params: {
    dt: number;
    input: Input;
    warp: number;
    mapMode: boolean;
    onFire: (ammoEvent: AmmoEvent) => void;
  }): PlayerActionState {
    const { dt, input, warp, mapMode, onFire } = params;
    const canAct = this.canAct(warp, mapMode);
    this.updateFireState({ dt, input, warp, mapMode, onFire });
    const thrustFn = this.updateThrustState(input, canAct);
    return { canAct, thrustFn };
  }

  updateFireState(params: {
    dt: number;
    input: Input;
    warp: number;
    mapMode: boolean;
    onFire: (ammoEvent: AmmoEvent) => void;
  }): void {
    const { dt, input, warp, mapMode, onFire } = params;
    const rawWantFire = this.readRawWantFire(input, warp, mapMode);
    const hasAmmo = this.hasAmmo();
    if (rawWantFire && !hasAmmo && this.alive && !this.wasEmptyClick) {
      this.sfx.emptyClick();
      this.hud.hint('弾薬切れ — 軌道上の補給マガジン ▣ を回収せよ', 3000);
    }
    this.wasEmptyClick = rawWantFire && !hasAmmo;
    if (this.reloadTimerValue > 0) {
      this.reloadTimerValue -= dt;
      this.wasFiring = false;
      return;
    }
    const wantFire = rawWantFire && this.alive && !mapMode && warp <= C.MAX_PHYS_WARP && hasAmmo;
    if (wantFire && !this.wasFiring) {
      this.sfx.spinUp();
      this.fireCooldown = C.SPINUP_TIME;
      this.fineAttitude = true;
    }
    this.wasFiring = wantFire;
    if (!wantFire) return;
    this.fireCooldown -= dt;
    if (this.fireCooldown > 0) return;
    onFire(this.consumeRound());
    this.fireCooldown = C.FIRE_INTERVAL;
  }

  private consumeRound(): AmmoEvent {
    this.roundsInMagValue--;
    if (this.roundsInMagValue > 0 || this.magsLeftValue <= 0) return 'none';
    this.magsLeftValue--;
    this.roundsInMagValue = C.MAG_ROUNDS;
    this.magsConsumedSinceReloadValue++;
    if (this.magsConsumedSinceReloadValue < 3) return 'mag';
    this.magsConsumedSinceReloadValue = 0;
    this.reloadTimerValue = C.RELOAD_TIME;
    return 'reload';
  }

  manualReload(): boolean {
    const canReload =
      this.reloadTimerValue <= 0 &&
      (this.roundsInMagValue < C.MAG_ROUNDS || this.magsConsumedSinceReloadValue > 0) &&
      this.magsLeftValue > 0;
    if (!canReload) return false;
    this.magsLeftValue--;
    this.roundsInMagValue = C.MAG_ROUNDS;
    this.magsConsumedSinceReloadValue = 0;
    this.reloadTimerValue = C.RELOAD_TIME;
    this.sfx.playReload();
    return true;
  }

  toggleRcsDamp(): void {
    this.rcsDamp = !this.rcsDamp;
    this.hud.hint(`RCS 回転制動: ${this.rcsDamp ? 'ON' : 'OFF'}`);
  }

  enableProgradeReset(): void {
    this.progradeHold = true;
    this.hud.hint('プログレード姿勢リセット(機首を進行方向へ)');
  }

  toggleFineAttitude(): void {
    this.fineAttitude = !this.fineAttitude;
    this.hud.hint(`姿勢微調整モード: ${this.fineAttitude ? 'ON' : 'OFF'}`);
  }

  toggleProgradeHold(): void {
    this.progradeHold = !this.progradeHold;
    this.hud.hint(`進行方向ホールド: ${this.progradeHold ? 'ON (機首をプログレードへ保持)' : 'OFF'}`);
  }

  setThrottlePreset(idx: number): void {
    this.setThrottle(idx);
    const labels = ['弱', '中', '強'] as const;
    this.hud.hint(`並進出力: ${labels[idx]!} (${C.THROTTLE_LEVELS[idx]!.toFixed(1)} m/s²)`);
  }

  onPickup(mags: number): void {
    this.magsLeftValue += mags;
    if (this.roundsInMagValue > 0) return;
    this.magsLeftValue--;
    this.roundsInMagValue = C.MAG_ROUNDS;
  }

  lossReasonByThermalLimit(limit: 'heat' | 'dynpressure' | null): string | null {
    if (!limit) return null;
    return limit === 'heat'
      ? '断熱圧縮による加熱で熱防御が飽和し、機体は焼失した'
      : '動圧が構造限界を超え、機体は空力的に分解した';
  }

  lossReasonByAltitude(altitude: number): string | null {
    if (!this.alive || altitude >= C.PLAYER_MIN_ALT) return null;
    return '濃密な大気に突入し機体は分解した';
  }

  setThrottle(idx: number): void {
    this.throttleIdx = idx;
  }

  clearTransientState(): void {
    this.thrustVizDir = null;
    this.thrustAccelVec = v3();
  }

  stopFiring(): void {
    this.wasFiring = false;
  }

  setFineAttitudeFromFiring(prevFiring: boolean, nowFiring: boolean): void {
    if (prevFiring && !nowFiring) this.fineAttitude = false;
  }

  private readRawWantFire(input: Input, warp: number, mapMode: boolean): boolean {
    const rawWantFire = !mapMode && (input.down('Space') || input.mouseFiring);
    if (rawWantFire && this.alive && warp > C.MAX_PHYS_WARP) {
      this.hud.hint(`射撃・推進はワープ ×${C.MAX_PHYS_WARP} 以下でのみ可能`);
    }
    return rawWantFire;
  }

  private updateThrustState(input: Input, canAct: boolean): ExtraAccel | null {
    const thrustFn = canAct ? this.buildThrustAccel(input) : null;
    this.sfx.setThrust(thrustFn !== null);
    this.updateThrustVisual(thrustFn);
    return thrustFn;
  }

  private buildThrustAccel(input: Input): ExtraAccel | null {
    const axX = (input.down('KeyA') ? 1 : 0) + (input.down('KeyD') ? -1 : 0);
    const axY = (input.down('KeyQ') ? 1 : 0) + (input.down('KeyE') ? -1 : 0);
    const axZ =
      (input.down('KeyW') || input.down('ControlLeft') || input.down('ControlRight') ? 1 : 0) +
      (input.down('KeyS') || input.down('ShiftLeft') || input.down('ShiftRight') ? -1 : 0);
    if (axX === 0 && axY === 0 && axZ === 0) return null;
    const thrustAccel = C.THROTTLE_LEVELS[this.throttleIdx]!;
    const q = this.att.q;
    return (): Vec3 => {
      const dir = norm(v3(axX, axY, axZ));
      return qRotate(q, scale(dir, thrustAccel));
    };
  }

  updateThrustVisual(thrustFn: ExtraAccel | null): void {
    if (!thrustFn) {
      this.thrustAccelVec = v3();
      this.thrustVizDir = null;
      return;
    }
    this.thrustAccelVec = thrustFn(this.state.r, this.state.v);
    this.thrustVizDir = norm(this.thrustAccelVec);
  }

  renderThrustEffects(
    plumeCore: THREE.Mesh,
    plumeOuter: THREE.Mesh,
    camera: THREE.PerspectiveCamera,
    zoomActive: boolean,
  ): void {
    const showPlume = this.thrustVizDir !== null && this.alive && !zoomActive;
    plumeCore.visible = showPlume;
    plumeOuter.visible = showPlume;
    if (!showPlume) return;
    const d = this.thrustVizDir!;
    const flick = 0.8 + 0.2 * Math.random();
    const sc = (1.5 + 2.5 * (this.throttleIdx / 3.0)) * flick;
    plumeCore.position.set(-d.x * 3.4, -d.y * 3.4, -d.z * 3.4);
    plumeCore.scale.setScalar(sc * 1.6);
    plumeCore.quaternion.copy(camera.quaternion);
    (plumeCore.material as THREE.MeshBasicMaterial).opacity = 0.85 * flick;
    plumeOuter.position.set(-d.x * 5.6, -d.y * 5.6, -d.z * 5.6);
    plumeOuter.scale.setScalar(sc * 3.6);
    plumeOuter.quaternion.copy(camera.quaternion);
    (plumeOuter.material as THREE.MeshBasicMaterial).opacity = 0.32 * flick;
  }

  updateRcsEffects(
    input: Input,
    rcsPuffs: THREE.Mesh[],
    activeCamera: THREE.PerspectiveCamera,
    zoomActive: boolean,
    phasePlaying: boolean,
    paused: boolean,
    mapMode: boolean,
  ): boolean {
    let tauX = (input.down('KeyI') ? 1 : 0) + (input.down('KeyK') ? -1 : 0);
    let tauY = (input.down('KeyL') ? 1 : 0) + (input.down('KeyJ') ? -1 : 0);
    let tauZ = (input.down('KeyO') ? 1 : 0) + (input.down('KeyU') ? -1 : 0);
    if (this.rcsDamp && this.alive && phasePlaying && !mapMode) {
      const w = this.att.w;
      const eps = C.RCS_DAMP_PUFF_EPS;
      if (tauX === 0 && Math.abs(w.x) > eps) tauX = -Math.sign(w.x);
      if (tauY === 0 && Math.abs(w.y) > eps) tauY = -Math.sign(w.y);
      if (tauZ === 0 && Math.abs(w.z) > eps) tauZ = -Math.sign(w.z);
    }
    const tau = v3(tauX, tauY, tauZ);
    const rotating = this.alive && phasePlaying && !paused && !mapMode && lenSq(tau) > 0.01;
    if (!rotating || zoomActive) {
      for (const p of rcsPuffs) p.visible = false;
      return false;
    }
    const q = this.att.q;
    for (let k = 0; k < 4; k++) {
      const puff = rcsPuffs[k]!;
      const ro = RCS_BLOCK_OFFSETS[k]!;
      const rb = v3(ro.x, ro.y, ro.z);
      const f = cross(tau, rb);
      if (lenSq(f) < 0.2) {
        puff.visible = false;
        continue;
      }
      const exhaust = scale(norm(f), -1);
      const flick = 0.6 + Math.random() * 0.4;
      const pos = qRotate(q, addScaled(rb, exhaust, 0.55));
      puff.position.set(pos.x, pos.y, pos.z);
      puff.scale.setScalar(0.55 * flick);
      puff.quaternion.copy(activeCamera.quaternion);
      (puff.material as THREE.MeshBasicMaterial).opacity = 0.75 * flick;
      puff.visible = true;
    }
    return true;
  }

  updateAttitude(
    input: Input,
    mapMode: boolean,
    attDt: number,
    onProgradeHoldReleased: () => void,
  ): void {
    if (!this.alive) return;
    const att = this.att;
    const inertia = att.inertia;
    const manual = mapMode ? 0 : 1;
    const inX = ((input.down('KeyI') ? 1 : 0) + (input.down('KeyK') ? -1 : 0)) * manual;
    const inY = ((input.down('KeyL') ? 1 : 0) + (input.down('KeyJ') ? -1 : 0)) * manual;
    const inZ = ((input.down('KeyO') ? 1 : 0) + (input.down('KeyU') ? -1 : 0)) * manual;

    const isRotating = inX !== 0 || inY !== 0 || inZ !== 0;
    this.rotationHoldTime = isRotating ? this.rotationHoldTime + attDt : 0;
    if (this.progradeHold && isRotating) {
      this.progradeHold = false;
      onProgradeHoldReleased();
    }

    const rcsOutputFactor =
      C.RCS_MANUAL_OUTPUT_MIN +
      C.RCS_MANUAL_OUTPUT_RAMP *
        (Math.min(C.RCS_MANUAL_RAMP_TIME, this.rotationHoldTime) / C.RCS_MANUAL_RAMP_TIME);
    const angScale = this.fineAttitude ? C.FINE_ATTITUDE_SCALE : 1;
    const maxAngAccel = C.MAX_ANG_ACCEL * angScale * rcsOutputFactor;
    const maxAngVel = C.MAX_ANG_VEL * angScale;
    const torque = v3(
      inX * maxAngAccel * inertia.x,
      inY * maxAngAccel * inertia.y,
      inZ * maxAngAccel * inertia.z,
    );

    if (this.progradeHold && inX === 0 && inY === 0 && inZ === 0) {
      const auto = this.autoAlignTorque(this.state.v, this.state.r, att, inertia);
      torque.x += auto.x;
      torque.y += auto.y;
      torque.z += auto.z;
    } else if (this.rcsDamp) {
      if (inX === 0) torque.x -= C.RCS_DAMP_RATE * inertia.x * att.w.x;
      if (inY === 0) torque.y -= C.RCS_DAMP_RATE * inertia.y * att.w.y;
      if (inZ === 0) torque.z -= C.RCS_DAMP_RATE * inertia.z * att.w.z;
    }
    stepAttitude(att, torque, attDt);
    const wMag = len(att.w);
    if (wMag > maxAngVel) att.w = scale(att.w, maxAngVel / wMag);
  }

  private autoAlignTorque(desiredFwd: Vec3, desiredUp: Vec3, att: Attitude, inertia: Vec3): Vec3 {
    const qd = qFromForwardUp(desiredFwd, desiredUp);
    if (!qd) return v3();
    const qDesired = new THREE.Quaternion(qd.x, qd.y, qd.z, qd.w);
    const qCurrent = new THREE.Quaternion(att.q.x, att.q.y, att.q.z, att.q.w);
    const qCurInv = qCurrent.clone().invert();
    const qErr = qDesired.multiply(qCurInv);
    const w = Math.max(-1, Math.min(1, qErr.w));
    let angle = 2 * Math.acos(w);
    if (angle > Math.PI) angle -= 2 * Math.PI;
    const s = Math.sqrt(Math.max(0, 1 - w * w));
    const axisWorld =
      s > 1e-6 ? new THREE.Vector3(qErr.x / s, qErr.y / s, qErr.z / s) : new THREE.Vector3(1, 0, 0);
    const axisBody = axisWorld.applyQuaternion(qCurInv);
    return v3(
      (C.PROGRADE_HOLD_KP * angle * axisBody.x - C.PROGRADE_HOLD_KD * att.w.x) * inertia.x,
      (C.PROGRADE_HOLD_KP * angle * axisBody.y - C.PROGRADE_HOLD_KD * att.w.y) * inertia.y,
      (C.PROGRADE_HOLD_KP * angle * axisBody.z - C.PROGRADE_HOLD_KD * att.w.z) * inertia.z,
    );
  }
}
