// プレイヤーの射撃・弾薬(マガジン/リロード)状態。発砲・排莢・バレル交換で出る実体と、
// そのとき起きたことの記録もここで組み立てる。
import type * as THREE from 'three/webgpu';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import { LOCAL_FORWARD, LOCAL_RIGHT, LOCAL_UP, qRotate, randomQuat } from '../../math/quat';
import { kinematicState, type KinematicState } from '../../physics/kinematic-state';
import { randSym } from '../../math/random';
import type { Vec3 } from '../../math/vec3';
import { add, addScaled, norm, randPerp, randVec, scale, v3 } from '../../math/vec3';

import type { PilotControls } from '../dynamic/dynamic-entity/pilot-controls';
import type { Ship } from '../dynamic/dynamic-entity/ship';
import { Bullet } from '../dynamic/dynamic-entity/bullet';
import type { EntityRegistry } from '../dynamic/entity-registry';
import { PLAYER_MUZZLE_OFFSETS } from '../../physics/player-shape';
import type { StageOutcome } from '../stages/stage-outcome';
import type { ModularShip } from '../ship/modular-ship';
import { DebrisPiece } from '../dynamic/dynamic-entity/debris-piece';
import { CASING_COLLISION_BOUND_RADIUS } from '../dynamic/dynamic-entity/casing-collision';
import { sunGlareSpreadScale } from '../combat/sun-glare-spread';
import {
  WeaponState, type SerializedWeaponState, type WeaponFireCommand,
} from './weapon-state';

export type { AmmoLoad } from './weapon-state';

const BARREL_PHYS_RADIUS = 0.8;
const EJECTED_MAG_PHYS_RADIUS = 1.4;

const GUN_HEAT_PER_ROUND = 5.5e5; // 1発あたりに外殻へ入る熱量 [J]

// 1発あたりに砲身へ入る熱量 [J]。発射ガスの熱の大半は砲身の側が受け取る。
const GUN_BARREL_HEAT_PER_ROUND = 1.0e6;

// 砲口の位置とそのときの艦の速度。砲口は機首方向 fwd へ少し先を取る。
function muzzleState(ship: Ship, muzzle: Vec3, fwd: Vec3): KinematicState {
  return kinematicState<'eci'>(
    ship.motion.state.t, addScaled(muzzle, fwd, 1.2), ship.motion.state.v,
  );
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

    const command = this.weapon.nextShot(PLAYER_MUZZLE_OFFSETS.length);
    if (command === null) return;
    this.weapon.fire(PLAYER_MUZZLE_OFFSETS.length);

    this.fireGun(command, activeStage, celestialBodies);
    // 装填の段階に応じて、次の発射までの間隔と排出物を決める
    switch (command.consumption) {
      case 'normal':
        this.weapon.setCooldown(1 / this.player.totalFireRate);
        return;
      case 'mag-reload':
        this.spawnEjectedMagazineFrame();
        this.registry.events.record({ kind: 'gunMagazineFed' });
        this.weapon.setCooldown(1 / this.player.totalFireRate);
        return;
      case 'barrel-reload':
        this.spawnEjectedMagazineFrame();
        this.weapon.setCooldown(RELOAD_TIME);
        this.dropBarrel();
        this.registry.events.record({ kind: 'gunBarrelSwapped' });
        return;
    }
  }

  // 手動リロードを試みる。開始できたら true。
  public manualReload(): boolean {
    if (!this.weapon.manualReload()) return false;
    this.weapon.setCooldown(RELOAD_TIME);
    this.registry.events.record({ kind: 'gunBarrelSwapped' });
    this.dropBarrel();
    return true;
  }

  // ---------------------------------------------------------------- entity管理

  // 1発発射する: 弾丸と薬莢を出し、反動と熱を艦へ入れ、発射したことを記録する。
  private fireGun(
    command: WeaponFireCommand,
    activeStage: StageOutcome,
    celestialBodies: CelestialBodies,
  ): void {
    const fwd = qRotate(this.player.motion.att.q, LOCAL_FORWARD);

    // 縦二連の砲口から交互に発射する
    const mo = PLAYER_MUZZLE_OFFSETS[command.muzzleIndex]!;
    const muzzle = add(
      this.player.motion.state.r,
      qRotate(this.player.motion.att.q, v3(mo.x, mo.y, mo.z)),
    );

    this.spawnBullet(muzzle, fwd, celestialBodies);
    // 反動(運動量保存の風味): 発射方向と逆に微小 Δv(瞬間的な速度変更なので時刻は据え置き)
    this.player.motion.reset(kinematicState<'eci'>(
      this.player.motion.state.t,
      this.player.motion.state.r,
      addScaled(this.player.motion.state.v, fwd, -RECOIL_DV),
    ));
    this.dropCasing(muzzle);

    activeStage.recordShot();
    this.player.motion.absorbHeat(GUN_HEAT_PER_ROUND / Math.max(this.player.motion.mass, 1e-9));
    this.weapon.addBarrelHeat(GUN_BARREL_HEAT_PER_ROUND);
    this.registry.events.record({ kind: 'gunFired', muzzleState: muzzleState(this.player, muzzle, fwd) });
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

  // 薬莢を -X 側(+X 側には給弾ベルトがある)へ、ゆっくり漂い個体ごとに大きくばらついて回るよう排出する。
  private dropCasing(muzzle: Vec3): void {
    const ship = this.player;
    // 機体姿勢基準の左右・上方向
    const right = qRotate(ship.motion.att.q, LOCAL_RIGHT);
    const up = qRotate(ship.motion.att.q, LOCAL_UP);
    this.registry.add(DebrisPiece.create(
      kinematicState<'eci'>(
        ship.motion.state.t,
        add(muzzle, scale(right, -1.4)),
        add(
          ship.motion.state.v,
          add(scale(right, -(0.5 + Math.random() * 0.3)), add(scale(up, randSym(0.2)), randVec(0.1))),
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

  // バレル交換時に円柱アイテムをデブリとして放出する。装着していた砲身の温度は、そのまま
  // 排出されたデブリへ移る。
  private dropBarrel(): void {
    const ship = this.player;
    // 下方に少し勢いをつけて放出
    const down = qRotate(ship.motion.att.q, v3(0, -1, 0));
    this.registry.add(DebrisPiece.create(
      kinematicState<'eci'>(
        ship.motion.state.t,
        add(ship.motion.state.r, qRotate(ship.motion.att.q, v3(0, -1, 1.5))), // 機首下部あたりから
        add(ship.motion.state.v, add(scale(down, 3.0), randVec(0.5))),
      ),
      {
        kind: 'barrel',
        bornTemperature: this.weapon.barrelTemperature,
        bornThermalDeviation: this.weapon.barrelDeviation,
      },
      {
        q: ship.motion.att.q,
        w: v3(randSym(2), randSym(2), randSym(2)),
        inertia: v3(1, 0.2, 1), // 円柱
      },
      this.registry.idAllocators, BARREL_PHYS_RADIUS, this.scene,
    ));
    this.weapon.mountFreshBarrel();
  }

  // 空になったマガジンの外枠を、-X 側(薬莢と同じ側)からデブリとして放出する。
  private spawnEjectedMagazineFrame(): void {
    const ship = this.player;
    // 排出ポートの位置と初速
    const right = qRotate(ship.motion.att.q, LOCAL_RIGHT);
    const portWorld = add(
      ship.motion.state.r, qRotate(ship.motion.att.q, v3(-0.9, 0, 0)),
    );
    this.registry.add(DebrisPiece.create(
      kinematicState<'eci'>(
        ship.motion.state.t,
        portWorld,
        add(
          ship.motion.state.v,
          add(scale(right, -(0.5 + Math.random() * 0.3)), randVec(0.15)),
        ),
      ),
      { kind: 'magazineFrame' },
      {
        q: ship.motion.att.q,
        w: v3(randSym(0.2), randSym(0.2), randSym(0.2)),
        inertia: v3(1, 1.2, 1.4),
      },
      this.registry.idAllocators, EJECTED_MAG_PHYS_RADIUS, this.scene,
    ));
  }
}
