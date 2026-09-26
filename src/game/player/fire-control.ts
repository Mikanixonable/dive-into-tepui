// プレイヤーの射撃・弾薬(マガジン/リロード)状態。発砲・排莢・バレル交換で出る実体と、
// そのとき起きたことの記録もここで組み立てる。
import type * as THREE from 'three/webgpu';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import { LOCAL_FORWARD, qMul, qRotate, randomQuat } from '../../math/quat';
import { kinematicState, type KinematicState } from '../../physics/kinematic-state';
import { randSym } from '../../math/random';
import type { Vec3 } from '../../math/vec3';
import { add, addScaled, norm, randPerp, randVec, scale, sub, v3 } from '../../math/vec3';

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
  WeaponState, type SerializedWeaponState,
} from './weapon-state';

export type { AmmoLoad } from './weapon-state';

const BARREL_PHYS_RADIUS = 1.45; // 砲身束の外接球(締め板半径 0.8 × 半長 1.2)
const EJECTED_MAG_PHYS_RADIUS = 1.4;

const GUN_HEAT_PER_ROUND = 5.5e5; // 1発あたりに外殻へ入る熱量 [J]

// 1発あたりに砲身へ入る熱量 [J]。発射ガスの熱の大半は砲身の側が受け取る。
const GUN_BARREL_HEAT_PER_ROUND = 1.0e6;

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

  // 弾薬・砲身の状態をシリアライズ形式へ変換する。
  public serialize(): SerializedFireControl {
    return this.weapon.serialize();
  }

  // 拾ったマガジン数を加算する。弾切れ中なら即座に1マガジンを装填する。
  public onPickup(mags: number): void {
    this.weapon.addMags(mags);
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
    this.weapon.fire(muzzles.length);

    const muzzle = muzzles[command.muzzleIndex]!;
    this.fireGun(muzzle, activeStage, celestialBodies);
    // 装填の段階に応じて、次の発射までの間隔と排出物を決める
    switch (command.consumption) {
      case 'normal':
        this.weapon.setCooldown(1 / this.player.totalFireRate);
        return;
      case 'mag-reload':
        this.spawnEjectedMagazineFrame(muzzle.weapon);
        this.registry.events.record({ kind: 'gunMagazineFed' });
        this.weapon.setCooldown(1 / this.player.totalFireRate);
        return;
      case 'barrel-reload':
        this.spawnEjectedMagazineFrame(muzzle.weapon);
        this.weapon.setCooldown(RELOAD_TIME);
        this.dropBarrel(muzzle.weapon);
        this.registry.events.record({ kind: 'gunBarrelSwapped' });
        return;
    }
  }

  // 手動リロードを試みる。開始できたら true。
  public manualReload(): boolean {
    if (!this.weapon.manualReload()) return false;
    this.weapon.setCooldown(RELOAD_TIME);
    this.registry.events.record({ kind: 'gunBarrelSwapped' });
    this.dropBarrel(this.player.capabilities.weaponPorts()[0] ?? null);
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
    this.weapon.addBarrelHeat(GUN_BARREL_HEAT_PER_ROUND);
    this.registry.events.record({ kind: 'gunFired', muzzleState: muzzleState(this.player, muzzleWorld) });
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

  // 装着している砲身の温度を dt だけ進める。
  public stepBarrelThermal(dt: number): void {
    this.weapon.stepBarrelThermal(dt);
  }

  // 砲身交換時に砲身束をデブリとして放出する。weapon があればその砲身取り外し点から -Y 方向へ
  // 出し、武装モジュールが残っていなければ機体下部の固定点から出す。装着していた砲身の温度は、
  // そのまま排出されたデブリへ移る。
  private dropBarrel(weapon: WeaponPorts | null): void {
    const ship = this.player;
    // 下方に少し勢いをつけて放出
    const down = weapon === null
      ? qRotate(ship.motion.att.q, v3(0, -1, 0))
      : this.worldDir(weapon.rotation, v3(0, -1, 0));
    const at = weapon === null
      ? add(ship.motion.state.r, qRotate(ship.motion.att.q, v3(0, -1, 1.5))) // 機首下部あたりから
      : this.worldPoint(weapon.barrelPort);
    this.registry.add(DebrisPiece.create(
      kinematicState<'eci'>(
        ship.motion.state.t,
        at,
        add(ship.motion.state.v, add(scale(down, 3.0), randVec(0.5))),
      ),
      {
        kind: 'barrel',
        bornTemperature: this.weapon.barrelTemperature,
        bornThermalDeviation: this.weapon.barrelDeviation,
      },
      {
        // 砲身束の長手はモジュールの +Z。武装が残っていなければ機体姿勢のまま落とす。
        q: weapon === null ? ship.motion.att.q : qMul(ship.motion.att.q, weapon.rotation),
        w: v3(randSym(2), randSym(2), randSym(2)),
        inertia: v3(1, 0.5, 1), // 砲身束: 外周へ砲身が張り出すので軸まわりは単管より大きい
      },
      this.registry.idAllocators, BARREL_PHYS_RADIUS, this.scene,
    ));
    this.weapon.mountFreshBarrel();
  }

  // 空になったマガジンの外枠を、撃ったモジュールの空リンク排出口(-X 側、薬莢と同じ側)から
  // デブリとして放出する。
  private spawnEjectedMagazineFrame(weapon: WeaponPorts): void {
    const ship = this.player;
    // 排出ポートの位置と初速
    const eject = this.worldDir(weapon.rotation, v3(-1, 0, 0));
    this.registry.add(DebrisPiece.create(
      kinematicState<'eci'>(
        ship.motion.state.t,
        this.worldPoint(weapon.linkExitPort),
        add(
          ship.motion.state.v,
          add(scale(eject, 0.5 + Math.random() * 0.3), randVec(0.15)),
        ),
      ),
      { kind: 'magazineFrame' },
      {
        q: qMul(ship.motion.att.q, weapon.rotation),
        w: v3(randSym(0.2), randSym(0.2), randSym(0.2)),
        inertia: v3(1, 1.2, 1.4),
      },
      this.registry.idAllocators, EJECTED_MAG_PHYS_RADIUS, this.scene,
    ));
  }
}
