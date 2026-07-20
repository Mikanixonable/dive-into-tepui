import * as THREE from 'three/webgpu';
import { Attitude, qFromForwardUp, qRotate } from '../../physics/attitude';
import { ExtraAccel, MU_EARTH, OrbitState, R_EARTH } from '../../physics/orbital';
import { Vec3, addScaled, cross, lenSq, norm, scale, v3 } from '../../physics/vec3';
import * as C from '../const';
import { DestroyEffectCtx, Ship } from '../entities';
import { Input } from '../input';
import { Hud } from '../../hud/hud';
import { Sfx } from '../../audio/sfx';
import { buildFlashMesh, buildPlayerShip, RCS_BLOCK_OFFSETS } from '../../render/ships';
import { getGlowTexture } from '../../render/glow-texture';
import type { CameraSystem } from '../camera/camera-system';
import { CombatCtx } from '../stages/stage-definition';
import { KillCounter } from '../combat/kill-counter';
import { PlayerThrottle } from './player-throttle';
import { FireCtx, PlayerFire } from './player-fire';
import { Belt } from './belt';
import { altitudeOf } from '../../physics/orbital';
import { ThermalSystem } from './thermal';
import { CheckLossCtx } from '../entities';
import { spawnBulletFlash, spawnFragments, spawnPlasmaFlash, spawnShipDestroyEffect } from '../effects-system';
import { HitInfo } from '../combat/hit';

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

  private readonly plumeCore: THREE.Mesh;
  private readonly plumeOuter: THREE.Mesh;
  private readonly rcsPuffs: THREE.Mesh[] = []; // RCS ブロック位置の噴射パフ(4基)

  // 高度420km・傾斜51.6°の円軌道に機首プログレードで初期配置する
  constructor(hud: Hud, sfx: Sfx, scene: THREE.Scene) {
    const state = Player.makeInitialState();
    super('PLAYER', state, buildPlayerShip(), Player.progradeAttitude(state), C.PLAYER_RADIUS, C.PLAYER_MAX_HP, scene);
    this.mass = 1000;
    // 剛体接触は実機体サイズ。被弾判定半径(radius)を使うと排莢直後の薬莢を弾いてしまう
    this.collideRadius = C.PLAYER_HULL_RADIUS;

    this.throttle = new PlayerThrottle(hud, sfx);
    this.fire = new PlayerFire(hud, sfx);
    this.belt = new Belt(this.obj);
    this.thermal = new ThermalSystem(hud, sfx);

    const plumes = this.buildThrustPlumes(scene);
    this.plumeCore = plumes.core;
    this.plumeOuter = plumes.outer;
    this.buildRcsPuffs(scene);
  }

  // マヌーバ噴射プルーム(推力方向の逆側に置く発光ビルボード 2 枚)
  private buildThrustPlumes(scene: THREE.Scene): { core: THREE.Mesh; outer: THREE.Mesh; } {
    const glowTex = getGlowTexture();
    const core = buildFlashMesh(glowTex, 0xaee6ff);
    const outer = buildFlashMesh(glowTex, 0x4f9fff);
    core.visible = false;
    outer.visible = false;
    scene.add(core);
    scene.add(outer);
    return { core, outer };
  }

  // RCS パフ(機首側の 4 基のスラスタブロックに対応、ships.ts の配置と一致)
  private buildRcsPuffs(scene: THREE.Scene): void {
    for (let i = 0; i < 4; i++) {
      const puff = buildFlashMesh(getGlowTexture(), 0xcfeaff);
      puff.visible = false;
      this.rcsPuffs.push(puff);
      scene.add(puff);
    }
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

  private updateHpRegen(dt: number): void {
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

  // マガジンベルトの毎フレーム更新(たわみ物理 + 表示メッシュ、弾薬状態に連動)。
  updateBelt(dt: number): void {
    this.belt.update(dt, this.fire.magsLeft, this.fire.roundsInMag, this.att, this.throttle.thrustAccelVec, this.alive);
  }

  // 毎フレームの HP 自然回復・押下エッジキー処理と、ユーザー入力に対する移動/発射の
  // 試行を一括で行う。実際の移動加速度の組み立ては PlayerThrottle、発砲・排莢の発注は
  // PlayerFire が持つ。canPlayerThrust/canPlayerFire(ワープ倍率による可否)は
  // SimSpeedManager が既に判定した結果を受け取る — ここで simSpeed 値そのものを見ない。
  // マップモード中は移動/発射の入力そのものを行わない(装填だけは実時間で進行する
  // — behaveMapMode 参照)ため、通常時とは別関数に分ける。
  behave(params: {
    dt: number;
    input: Input;
    canPlayerThrust: boolean;
    canPlayerFire: boolean;
    mapMode: boolean;
    killCounter: KillCounter;
    fireCtx: FireCtx;
  }): PlayerActionState {
    const { dt, input, canPlayerThrust, canPlayerFire, mapMode, killCounter, fireCtx } = params;
    this.updateHpRegen(dt);
    if (mapMode) return this.behaveMapMode(dt);
    return this.behaveFlying(dt, input, canPlayerThrust, canPlayerFire, killCounter, fireCtx);
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
    killCounter: KillCounter,
    fireCtx: FireCtx,
  ): PlayerActionState {
    const canThrust = canPlayerThrust && this.alive;
    const canFire = canPlayerFire && this.alive;
    const justStartedFiring = this.fire.updateFireState(dt, input, this.alive, canFire, this, killCounter, fireCtx);
    if (justStartedFiring) this.throttle.fineAttitude = true;
    const thrustFn = this.throttle.updateThrustState(input, canThrust, this.att, this.state);
    return { thrustFn };
  }

    // 押下エッジキーの処理し、担当外のキーを記録
  handleEdgeInput(presses: string[], fireCtx: FireCtx): string[] {
    return presses.filter((code) => !this.handleEdgePress(code, fireCtx));
  }

  private handleEdgePress(code: string, fireCtx: FireCtx): boolean {
    switch (code) {
      case 'KeyT': this.throttle.toggleRcsDamp(); return true;
      case 'KeyF': this.throttle.enableProgradeReset(); return true;
      case 'KeyV': this.throttle.toggleFineAttitude(); return true;
      case 'KeyC': this.throttle.toggleProgradeHold(); return true;
      case 'Digit1': this.throttle.setThrottlePreset(0); return true;
      case 'Digit2': this.throttle.setThrottlePreset(1); return true;
      case 'Digit3': this.throttle.setThrottlePreset(2); return true;
      case 'KeyR':
        if (this.fire.manualReload()) this.fire.dropBarrel(fireCtx, this);
        return true;
      default: return false;
    }
  }
  
  // 被弾によるダメージ・致死判定。
  attacked(hit: HitInfo, ctx: CombatCtx): void {
    if (!this.alive) return;
    const effectCtx = { sfx: ctx.sfx, fx: ctx.fx };

    // todo: 弾種でダメージ分岐しないのか
    this.hp -= C.PLAYER_HIT_DAMAGE
    if (this.hp > 0) {
      this.hitEffect(effectCtx, hit);
      return;
    }

    this.alive = false;
    const reason = hit.shooter === 'player' ? '自弾の被弾により機体を喪失した' : '敵のエネルギー弾により機体を喪失した';
    ctx.activeStage.recordKilled(ctx, reason);
    this.destroyEffect(effectCtx);
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
    this.destroyEffect({ sfx: ctx.combatCtx.sfx, fx: ctx.combatCtx.fx });
    ctx.combatCtx.activeStage.recordKilled(ctx.combatCtx, reason);
  }

  // 被弾時の音・火花・欠片(致死判定に関係なく毎回発生する演出)。
  private hitEffect(ctx: DestroyEffectCtx, hit: HitInfo): void {
    ctx.sfx.hit();
    if (hit.kind === 'plasma') {
      spawnPlasmaFlash(ctx.fx, hit.pos, hit.vel);
    } else {
      spawnBulletFlash(ctx.fx, hit.pos, hit.vel);
    }
    spawnFragments(ctx.fx, hit.pos, hit.vel, C.HIT_FRAG_COUNT, 0x6a7078, C.HIT_FRAG_SIZE_MIN, C.HIT_FRAG_SIZE_MAX, C.HIT_FRAG_SPEED);
  }
  
  private destroyEffect(ctx: DestroyEffectCtx): void {
    ctx.sfx.explosion();
    spawnShipDestroyEffect(ctx.fx, this.state.r, this.state.v, 1, 0x9fd8e8);
  }

  // ポーズ中: 移動/発射の一時状態(推力可視化・射撃継続)を止める。
  pause(): void {
    this.throttle.clearTransientState();
    this.fire.stopFiring();
  }

  setFineAttitudeFromFiring(prevFiring: boolean, nowFiring: boolean): void {
    this.throttle.setFineAttitudeFromFiring(prevFiring, nowFiring);
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

  // -------------------------------------------------------------- 描画

  // floating origin のため自機は常にワールド原点。ズーム中(PIP)は本体を隠す。
  render(zoomActive: boolean): void {
    this.obj.position.set(0, 0, 0);
    this.obj.quaternion.set(this.att.q.x, this.att.q.y, this.att.q.z, this.att.q.w);
    this.obj.visible = this.alive && !zoomActive;
  }

  renderThrustEffects(camera: CameraSystem): void {
    const dir = this.throttle.thrustVizDir;
    const showPlume = dir !== null && this.alive && !camera.zoomActive;
    this.plumeCore.visible = showPlume;
    this.plumeOuter.visible = showPlume;
    if (!showPlume) return;
    const d = dir!;
    const flick = 0.8 + 0.2 * Math.random();
    const sc = (1.5 + 2.5 * (this.throttle.throttleIdx / 3.0)) * flick;
    this.plumeCore.position.set(-d.x * 3.4, -d.y * 3.4, -d.z * 3.4);
    this.plumeCore.scale.setScalar(sc * 1.6);
    this.plumeCore.quaternion.copy(camera.activeCamera.quaternion);
    (this.plumeCore.material as THREE.MeshBasicMaterial).opacity = 0.85 * flick;
    this.plumeOuter.position.set(-d.x * 5.6, -d.y * 5.6, -d.z * 5.6);
    this.plumeOuter.scale.setScalar(sc * 3.6);
    this.plumeOuter.quaternion.copy(camera.activeCamera.quaternion);
    (this.plumeOuter.material as THREE.MeshBasicMaterial).opacity = 0.32 * flick;
  }

  updateRcsEffects(
    input: Input,
    camera: CameraSystem,
    phasePlaying: boolean,
    paused: boolean,
  ): boolean {
    const tau = this.throttle.computeRcsTau(input, this.att.w, this.alive, phasePlaying, camera.mapMode);
    const rotating = this.alive && phasePlaying && !paused && !camera.mapMode && lenSq(tau) > 0.01;
    if (!rotating || camera.zoomActive) {
      for (const p of this.rcsPuffs) p.visible = false;
      return false;
    }
    const q = this.att.q;
    for (let k = 0; k < 4; k++) {
      const puff = this.rcsPuffs[k]!;
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
      puff.quaternion.copy(camera.activeCamera.quaternion);
      (puff.material as THREE.MeshBasicMaterial).opacity = 0.75 * flick;
      puff.visible = true;
    }
    return true;
  }
}
