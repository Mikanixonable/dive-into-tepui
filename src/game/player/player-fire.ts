// プレイヤーの射撃・弾薬(マガジン/リロード)状態と、それに連動するマガジンベルト
// (未使用弾のベルト、Verlet 物理 + 表示メッシュは belt.ts の BeltPhysics)。
// 実際の発砲・排莢演出は CombatSystem に委ねる(combat.ts は game.ts を import
// しないため、ここから combat/combatCtx を直接渡す)。
import * as THREE from 'three/webgpu';
import { Attitude, Quat } from '../../physics/attitude';
import { Vec3 } from '../../physics/vec3';
import * as C from '../const';
import { Input } from '../input';
import { Hud } from '../../hud/hud';
import { Sfx } from '../../audio/sfx';
import { BeltPhysics } from '../combat/belt';
import { BeltSection } from '../entities';
import { buildMagazineMesh, MAG_BELT_PITCH } from '../../render/ships';
import { CombatCtx, CombatSystem } from '../combat/combat';

type AmmoEvent = 'none' | 'mag' | 'reload';

export class PlayerFire {
  private fireCooldown = 0;
  private wasFiring = false;
  private wasEmptyClick = false;
  private roundsInMagValue = C.MAG_ROUNDS;
  private magsLeftValue = C.INITIAL_MAGS - 1;
  private magsConsumedSinceReloadValue = 0;
  private reloadTimerValue = 0;

  // マガジンベルト(未使用の実弾入りマガジン): 機体左面(+X)に垂直に連結する。
  // 先頭リンクは機体に半分取り込まれた位置に置く(給弾中もベルトごと取り込まれて
  // いる見た目)。弾を撃ち尽くすたびに機体反対側(-X)からフレームだけの空マガジンが
  // デブリとして放出される(CombatSystem.spawnEjectedMagazineFrame 参照)。
  private readonly beltGroup = new THREE.Group();
  private readonly beltLinks: THREE.Group[] = [];
  private readonly belt: BeltPhysics;
  private beltFeed = 0;

  constructor(
    private readonly hud: Hud,
    private readonly sfx: Sfx,
    playerObj: THREE.Object3D,
  ) {
    for (let i = 0; i < C.BELT_MAX_VISIBLE; i++) {
      const link = buildMagazineMesh();
      link.position.x = 0.9 + i * MAG_BELT_PITCH;
      this.beltGroup.add(link);
      this.beltLinks.push(link);
    }
    playerObj.add(this.beltGroup);
    this.belt = new BeltPhysics(this.beltLinks);
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

  onPickup(mags: number): void {
    this.magsLeftValue += mags;
    if (this.roundsInMagValue > 0) return;
    this.magsLeftValue--;
    this.roundsInMagValue = C.MAG_ROUNDS;
  }

  stopFiring(): void {
    this.wasFiring = false;
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

  private hasAmmo(): boolean {
    return this.roundsInMagValue > 0 || this.magsLeftValue > 0;
  }

  // 機体が生存していてワープ倍率が射撃可能範囲内か。マップモードは呼び出し側
  // (updateFireState の keyHeld)で既に除外済みなのでここでは見ない。
  private canFire(alive: boolean, warp: number): boolean {
    return alive && warp <= C.MAX_PHYS_WARP;
  }

  // 発砲入力を処理し、発射・排莢・リロードを CombatSystem に発注する。
  // 戻り値は「このフレームで発砲を新規開始したか」— fineAttitude の有効化は
  // 移動系(PlayerThrottle)の責務なので、呼び出し元(Player)へ判定だけ返す。
  updateFireState(
    dt: number,
    input: Input,
    alive: boolean,
    warp: number,
    mapMode: boolean,
    combat: CombatSystem,
    combatCtx: CombatCtx,
  ): boolean {
    const keyHeld = !mapMode && (input.down('Space') || input.mouseFiring);
    if (keyHeld && alive && warp > C.MAX_PHYS_WARP) {
      this.hud.hint(`射撃・推進はワープ ×${C.MAX_PHYS_WARP} 以下でのみ可能`);
    }
    const hasAmmo = this.hasAmmo();
    if (keyHeld && !hasAmmo && alive && !this.wasEmptyClick) {
      this.sfx.emptyClick();
      this.hud.hint('弾薬切れ — 軌道上の補給マガジン ▣ を回収せよ', 3000);
    }
    this.wasEmptyClick = keyHeld && !hasAmmo;

    // リロードは戦闘可否(マップモード/ワープ/生死)に関わらず実時間で進行する
    // (時間ワープ中でも装填サイクルは現実時間で完了する)。
    if (this.reloadTimerValue > 0) {
      this.reloadTimerValue -= dt;
      this.wasFiring = false;
      return false;
    }

    const wantFire = keyHeld && hasAmmo && this.canFire(alive, warp);
    const justStartedFiring = wantFire && !this.wasFiring;
    this.wasFiring = wantFire;
    if (!wantFire) return justStartedFiring;

    if (justStartedFiring) {
      this.sfx.spinUp();
      this.fireCooldown = C.SPINUP_TIME;
    }
    this.fireCooldown -= dt;
    if (this.fireCooldown > 0) return justStartedFiring;
    this.fireCooldown = C.FIRE_INTERVAL;

    combat.fireGun(combatCtx);
    const ammoEvent = this.consumeRound();
    if (ammoEvent === 'mag') {
      combat.spawnEjectedMagazineFrame(combatCtx);
      this.sfx.magFeed();
    } else if (ammoEvent === 'reload') {
      combat.spawnEjectedMagazineFrame(combatCtx);
      combat.dropBarrel(combatCtx);
      this.sfx.playReload();
    }
    return justStartedFiring;
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

  // ---------------------------------------------------------------- belt

  // マガジンベルトの毎フレーム更新(たわみ物理 + 表示メッシュ)。給弾量
  // (beltCount/beltFeed)は自身が持つ弾薬状態から直接導出する。
  updateBelt(dt: number, att: Attitude, thrustAccelVec: Vec3, alive: boolean): void {
    const beltCount = Math.min(this.magsLeftValue, C.BELT_MAX_VISIBLE);
    const targetFeed = 1 - this.roundsInMagValue / C.MAG_ROUNDS;
    if (targetFeed < this.beltFeed - 0.5) {
      this.belt.shiftBeltNodes();
      this.beltFeed = targetFeed;
    } else {
      this.beltFeed += (targetFeed - this.beltFeed) * Math.min(1, dt * 12);
    }
    this.belt.updateBeltPhysics(dt, beltCount, att, thrustAccelVec, this.beltFeed, alive);
  }

  // ---- 剛体接触 (collision.ts) との受け渡し。r/v/q は呼び出し元(Player)が
  // 自身の state/att から渡す — ベルトは機体座標系の Verlet 状態を持つのみ。
  collisionSections(dt: number, r: Vec3, v: Vec3, q: Quat): BeltSection[] {
    return this.belt.collisionSections(dt, r, v, q);
  }

  applyCollisionSections(dt: number, r: Vec3, v: Vec3, q: Quat): void {
    this.belt.applyCollisionSections(dt, r, v, q);
  }
}
