// プレイヤーの射撃・弾薬(マガジン/リロード)状態。発砲・排莢・バレル交換で出る実体と、
// そのとき起きたことの記録もここで組み立てる。
import type * as THREE from 'three/webgpu';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import { LOCAL_FORWARD, qMul, qRotate, randomQuat } from '../../math/quat';
import { kinematicState, type KinematicState } from '../../physics/kinematic-state';
import { randSym } from '../../math/random';
import type { Vec3 } from '../../math/vec3';
import { add, addScaled, norm, randPerp, randVec, scale, sub, v3 } from '../../math/vec3';
import { MAG_WIDTH } from '../../physics/player-shape';

import type { PilotControls } from '../dynamic/dynamic-entity/pilot-controls';
import type { Ship } from '../dynamic/dynamic-entity/ship';
import { Bullet } from '../dynamic/dynamic-entity/bullet';
import type { EntityRegistry } from '../dynamic/entity-registry';
import type { StageOutcome } from '../stages/stage-outcome';
import type { ModularShip } from '../ship/modular-ship';
import type { WeaponMuzzle, WeaponPorts } from '../ship/ship-capabilities';
import { DebrisPiece } from '../dynamic/dynamic-entity/debris-piece';
import { CASING_COLLISION_BOUND_RADIUS } from '../dynamic/dynamic-entity/casing-collision';
import { sunGlareSpreadScale } from '../combat/sun-glare-spread';
import {
  WeaponState, type SerializedWeaponState, type WeaponShotRecord,
} from './weapon-state';

export type { AmmoLoad } from './weapon-state';

const EJECTED_MAG_PHYS_RADIUS = 1.4;
// 空マガジン外枠がリンク排出口へ出るスライド。内側へ潜った位置から面の外まで [m]・[s]。
const MAG_FRAME_SLIDE_DEPTH = 0.55;
const MAG_FRAME_SLIDE_TIME = 0.3;
const CARTRIDGE_FRAME_SLIDE_DEPTH = 0.38;
const CARTRIDGE_FRAME_SLIDE_TIME = 0.22;
const MAG_FRAME_QUEUE_DEPTH = CARTRIDGE_FRAME_SLIDE_DEPTH + MAG_WIDTH + 0.15;

const GUN_HEAT_PER_ROUND = 5.5e5; // 1発あたりに外殻へ入る熱量 [J]

// 砲口の位置とそのときの艦の速度。
function muzzleState(ship: Ship, muzzle: Vec3): KinematicState {
  return kinematicState<'eci'>(ship.motion.state.t, muzzle, ship.motion.state.v);
}

const SPINUP_TIME = 0.15; // 発射開始から実際に撃ち始めるまでの起動遅延 [s]
const BULLET_SPREAD = 0.002; // 散布界 [rad]

const BULLET_LIFETIME = 240; // 保険としての寿命 [sim s]
const RECOIL_DV = 0.04; // 反動 [m/s]

const RELOAD_TIME = 1.0; // 手動/自動リロード(バレル交換)のクールダウン [s]

export type SerializedFireControl = SerializedWeaponState;

export class FireControl {
  // player が撃つ。発砲で出る実体と出来事は registry へ積む。weapon は弾薬・砲身の状態で、省けば
  // 既定の積載で始める。
  public constructor(
    private readonly player: ModularShip,
    private readonly registry: EntityRegistry,
    private readonly scene: THREE.Scene,
    private readonly weapon = new WeaponState(),
  ) {}

  public get rounds(): number { return this.weapon.rounds; }
  public get mags(): number { return this.weapon.mags; }
  public get cooldown(): number { return this.weapon.cooldown; }
  public get isFiring(): boolean { return this.weapon.wasFiring; }
  public get recentShotRecords(): readonly WeaponShotRecord[] { return this.weapon.recentShots; }
  public get cartridgeAdvancedAt(): number | null { return this.weapon.cartridgeAdvancedAt; }
  public get magazineFedAt(): number | null { return this.weapon.magazineFedAt; }

  // 弾薬・砲身の状態をシリアライズ形式へ変換する。
  public serialize(): SerializedFireControl {
    return this.weapon.serialize();
  }

  // 拾ったマガジン数を加算する。弾切れ中なら即座に1マガジンを装填する。
  public onPickup(mags: number): void {
    if (!Number.isFinite(mags) || mags <= 0) return;
    this.weapon.addMags(mags, this.player.motion.state.t);
  }

  // 発射状態を強制的に解除する。
  public stopFiring(): void {
    this.weapon.releaseTrigger();
  }

  // 発射の操作量を1フレーム分処理する。トリガーが引かれ、火器が生きていて弾が残っていれば発射する。
  public updateFireState(
    dt: number,
    controls: PilotControls,
    activeStage: StageOutcome,
    celestialBodies: CelestialBodies,
  ): void {
    this.weapon.retainShotModules(new Set(this.player.capabilities.modules('weapon', true).map(module => module.id)));
    this.weapon.tickCooldown(dt);

    if (!controls.firing) {
      // トリガーを離したら連射状態を畳む。畳まないと次に引いたときにスピンアップが起きない。
      this.weapon.releaseTrigger();
      return;
    }

    // 火器が全損しているか弾が尽きていれば、撃てなかったことを次に撃てるまでに1度だけ記録する
    if (this.player.totalFireRate <= 0) {
      if (!this.weapon.wasEmptyClick) {
        this.registry.events.record({ kind: 'gunDryFired' });
        this.registry.events.record({ kind: 'gunDisabled' });
        this.weapon.markEmptyClick();
      }
      return;
    }

    if (!this.weapon.left) {
      if (!this.weapon.wasEmptyClick) {
        this.registry.events.record({ kind: 'gunDryFired' });
        this.registry.events.record({ kind: 'gunOutOfAmmo' });
        this.weapon.markEmptyClick();
      }
      return;
    }

    this.fireCycle(activeStage, celestialBodies);
  }

  // クールダウン込みの発射サイクルを1回進める。スピンアップ中・クールダウン中は発射しない。
  private fireCycle(activeStage: StageOutcome, celestialBodies: CelestialBodies): void {
    const justStartedFiring = !this.weapon.wasFiring;
    this.weapon.pullTrigger();

    // 起動時のタイムラグ
    if (justStartedFiring) {
      this.registry.events.record({ kind: 'gunSpunUp' });
      this.weapon.setCooldown(SPINUP_TIME);
      return;
    }

    // 起動時及びクールダウン中は発射しない
    if (0 < this.weapon.cooldown) {
      return;
    }

    const muzzles = this.player.capabilities.weaponMuzzles();
    const command = this.weapon.nextShot(muzzles.length);
    if (command === null) return;
    const cycleDuration = muzzles.length / this.player.totalFireRate;
    this.weapon.fire(muzzles.length, this.player.motion.state.t);

    const muzzle = muzzles[command.muzzleIndex]!;
    this.fireGun(muzzle, activeStage, celestialBodies, cycleDuration);
    // 弾薬の区切りごとの実体を排出し、連続給弾の発射間隔を保つ
    switch (command.consumption) {
      case 'normal':
        this.weapon.setCooldown(1 / this.player.totalFireRate);
        return;
      case 'cartridge-advance':
        this.spawnEjectedCartridgeFrame(muzzle.weapon);
        this.weapon.setCooldown(1 / this.player.totalFireRate);
        return;
      case 'magazine-finished':
        this.spawnEjectedCartridgeFrame(muzzle.weapon);
        this.spawnEjectedMagazineFrame(muzzle.weapon, true);
        if (this.weapon.rounds > 0) this.registry.events.record({ kind: 'gunMagazineFed' });
        this.weapon.setCooldown(1 / this.player.totalFireRate);
        return;
    }
  }

  // 手動リロードを試みる。開始できたら true。捨てるマガジンの外枠を、健全な武装があればその
  // リンク排出口から出す。
  public manualReload(): boolean {
    if (!this.weapon.manualReload(this.player.motion.state.t)) return false;
    this.weapon.setCooldown(RELOAD_TIME);
    this.registry.events.record({ kind: 'gunReloaded' });
    const weapon = this.player.capabilities.weaponPorts()[0];
    if (weapon !== undefined) this.spawnEjectedMagazineFrame(weapon);
    return true;
  }

  // ---------------------------------------------------------------- entity管理

  // assembly 座標 [m] の点を ECI 座標へ写す。
  private worldPoint(assemblyPoint: Vec3): Vec3 {
    return add(
      this.player.motion.state.r,
      qRotate(this.player.motion.att.q, sub(assemblyPoint, this.player.motion.centerOffset)),
    );
  }

  // モジュール姿勢 moduleRot の局所方向 dir を ECI 方向へ写す。
  private worldDir(moduleRot: WeaponPorts['rotation'], dir: Vec3): Vec3 {
    return qRotate(this.player.motion.att.q, qRotate(moduleRot, dir));
  }

  // 1発発射する: assembly 座標 [m] の砲身先端から弾丸を出し、撃ったモジュールの排莢口から薬莢を
  // 出して、反動と熱を艦へ入れ、発射したことを記録する。
  private fireGun(
    muzzle: WeaponMuzzle,
    activeStage: StageOutcome,
    celestialBodies: CelestialBodies,
    cycleDuration: number,
  ): void {
    const fwd = qRotate(this.player.motion.att.q, LOCAL_FORWARD);
    const muzzleWorld = this.worldPoint(muzzle.position);

    this.spawnBullet(muzzleWorld, fwd, celestialBodies);
    // 反動(運動量保存の風味): 発射方向と逆に微小 Δv(瞬間的な速度変更なので時刻は据え置き)
    this.player.motion.reset(kinematicState<'eci'>(
      this.player.motion.state.t,
      this.player.motion.state.r,
      addScaled(this.player.motion.state.v, fwd, -RECOIL_DV),
    ));
    this.dropCasing(muzzle.weapon);

    activeStage.recordShot();
    this.player.motion.absorbHeat(GUN_HEAT_PER_ROUND / Math.max(this.player.motion.mass, 1e-9));
    this.registry.events.record({ kind: 'gunFired', muzzleState: muzzleState(this.player, muzzleWorld) });
    this.weapon.recordShot({
      moduleId: muzzle.weapon.moduleId,
      muzzleIndex: muzzle.muzzleIndex,
      firedAt: this.player.motion.state.t,
      cycleDuration,
    });
  }

  // 弾丸: 機首方向 + 散布界
  private spawnBullet(muzzle: Vec3, fwd: Vec3, celestialBodies: CelestialBodies): void {
    const ship = this.player;
    const spreadScale = sunGlareSpreadScale(muzzle, fwd, celestialBodies, ship.motion.state.t);
    // 機首方向に散布角を加えた発射方向
    const spread = Math.abs(randSym(BULLET_SPREAD)) * spreadScale;
    const dir = norm(addScaled(fwd, randPerp(fwd), spread));
    this.registry.add(Bullet.create(
      kinematicState<'eci'>(
        ship.motion.state.t,
        addScaled(muzzle, fwd, 1.5),
        addScaled(ship.motion.state.v, dir, ship.averageMuzzleVelocity),
      ),
      BULLET_LIFETIME,
      'player',
      'normal',
      ship.weaponDamage,
      this.registry.idAllocators,
    ));
  }

  // 薬莢を撃ったモジュールの排莢口(樋の向き -X、+X 側には給弾ベルトがある)から、ゆっくり漂い
  // 個体ごとに大きくばらついて回るよう排出する。
  private dropCasing(weapon: WeaponPorts): void {
    const ship = this.player;
    // モジュール姿勢基準の排莢方向と上方向
    const eject = this.worldDir(weapon.rotation, v3(-1, 0, 0));
    const up = this.worldDir(weapon.rotation, v3(0, 1, 0));
    this.registry.add(DebrisPiece.create(
      kinematicState<'eci'>(
        ship.motion.state.t,
        this.worldPoint(weapon.ejectionPort),
        add(
          ship.motion.state.v,
          add(scale(eject, 0.5 + Math.random() * 0.3), add(scale(up, randSym(0.2)), randVec(0.1))),
        ),
      ),
      { kind: 'casing', bornSim: ship.motion.state.t },
      {
        q: randomQuat(),
        w: v3(randSym(6.0), randSym(6.0), randSym(6.0)),
        inertia: v3(0.85, 0.3, 1.15), // 円筒: 長軸(y)が最小。x/z も非対称にしジャニベコフ効果を起こす
      },
      this.registry.idAllocators, CASING_COLLISION_BOUND_RADIUS, this.scene,
    ));
  }

  // 空マガジン外枠をカートリッジ枠と同じ -X 側の排出口へ送り、出口手前で一列になるよう並べる。
  private spawnEjectedMagazineFrame(weapon: WeaponPorts, queuedBehindCartridgeFrame = false): void {
    const ship = this.player;
    // スライド経路(モジュール局所): 排出口の内側から面の外へ。終端にわずかなばらつきを足して
    // 出て行く方向が個体ごとに散るようにする。
    const inward = qRotate(weapon.rotation, v3(1, 0, 0));
    const inwardDepth = queuedBehindCartridgeFrame
      ? MAG_FRAME_QUEUE_DEPTH
      : MAG_FRAME_SLIDE_DEPTH;
    const inner = add(weapon.linkExitPort, scale(inward, inwardDepth));
    const outer = add(
      add(weapon.linkExitPort, scale(inward, -MAG_FRAME_SLIDE_DEPTH)),
      qRotate(weapon.rotation, randVec(0.12)),
    );
    const slideSpeed = queuedBehindCartridgeFrame
      ? (CARTRIDGE_FRAME_SLIDE_DEPTH * 2) / CARTRIDGE_FRAME_SLIDE_TIME
      : (MAG_FRAME_SLIDE_DEPTH * 2) / MAG_FRAME_SLIDE_TIME;
    const slideDuration = (inwardDepth + MAG_FRAME_SLIDE_DEPTH) / slideSpeed;
    const eject = this.worldDir(weapon.rotation, v3(-1, 0, 0));
    const t = ship.motion.state.t;
    this.registry.add(DebrisPiece.create(
      kinematicState<'eci'>(
        t,
        this.worldPoint(inner),
        add(ship.motion.state.v, scale(eject, slideSpeed)),
      ),
      {
        kind: 'magazineFrame',
        slide: {
          bornSim: t,
          duration: slideDuration,
          r0: ship.motion.state.r,
          q0: ship.motion.att.q,
          v0: ship.motion.state.v,
          from: sub(inner, ship.motion.centerOffset),
          to: sub(outer, ship.motion.centerOffset),
        },
      },
      {
        q: qMul(ship.motion.att.q, weapon.rotation),
        w: v3(randSym(0.2), randSym(0.2), randSym(0.2)),
        inertia: v3(1, 1.2, 1.4),
      },
      this.registry.idAllocators, EJECTED_MAG_PHYS_RADIUS, this.scene,
    ));
  }

  // 空カートリッジ骨組みを、マガジン外枠と共有する排出口からスライドで排出する。
  private spawnEjectedCartridgeFrame(weapon: WeaponPorts): void {
    const ship = this.player;
    const inward = qRotate(weapon.rotation, v3(1, 0, 0));
    const exit = weapon.linkExitPort;
    // 共有口の内側から外側へ移る軌道を、船体の運動へ重ねる。
    const inner = add(exit, scale(inward, CARTRIDGE_FRAME_SLIDE_DEPTH));
    const outer = add(
      add(exit, scale(inward, -CARTRIDGE_FRAME_SLIDE_DEPTH)),
      qRotate(weapon.rotation, randVec(0.04)),
    );
    const slideSpeed = (CARTRIDGE_FRAME_SLIDE_DEPTH * 2) / CARTRIDGE_FRAME_SLIDE_TIME;
    const eject = this.worldDir(weapon.rotation, v3(-1, 0, 0));
    const t = ship.motion.state.t;
    // スライドの終点と初期回転を持つ破片として登録する。
    this.registry.add(DebrisPiece.create(
      kinematicState<'eci'>(
        t,
        this.worldPoint(inner),
        add(ship.motion.state.v, scale(eject, slideSpeed)),
      ),
      {
        kind: 'cartridgeFrame',
        bornSim: t,
        slide: {
          bornSim: t,
          duration: CARTRIDGE_FRAME_SLIDE_TIME,
          r0: ship.motion.state.r,
          q0: ship.motion.att.q,
          v0: ship.motion.state.v,
          from: sub(inner, ship.motion.centerOffset),
          to: sub(outer, ship.motion.centerOffset),
        },
      },
      {
        q: qMul(ship.motion.att.q, weapon.rotation),
        w: v3(randSym(0.35), randSym(0.35), randSym(0.35)),
        inertia: v3(0.35, 0.5, 0.7),
      },
      this.registry.idAllocators, 0.65, this.scene,
    ));
  }
}
