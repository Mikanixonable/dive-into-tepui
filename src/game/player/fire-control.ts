// プレイヤーの射撃・弾薬(マガジン/リロード)状態。発砲・排莢・バレル交換の演出もここで組み立てる。
import * as THREE from 'three/webgpu';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import { LOCAL_FORWARD, LOCAL_RIGHT, LOCAL_UP, qRotate, randomQuat } from '../../math/quat';
import { kinematicState } from '../../physics/kinematic-state';
import { R_EARTH_EQ } from '../celestial/solar-system/constants';
import { randSym } from '../../math/random';
import { radiativeCooling, stepTemperature, stepThermalDeviation } from '../../physics/thermal';
import { add, addScaled, norm, randPerp, randVec, scale, v3, Vec3 } from '../../math/vec3';

import { Input } from '../../input/input';
import { KEY_MAPPING as K } from '../../input/key-mapping';
import type { Notifier } from '../../hud/notifier';
import { WorldSfx } from '../../audio/sfx/world-sfx';
import { Ship } from '../dynamic/dynamic-entity/ship';
import { Bullet } from '../dynamic/dynamic-entity/bullet';
import type { EntityRegistry } from '../dynamic/entity-registry';
import { PLAYER_MUZZLE_OFFSETS } from '../../physics/player-shape';
import { FlashEffects } from '../vfx/flash-effects';
import type { StageOutcome } from '../stages/stage-outcome';
import { Player } from './player';
import type { FireSaveData } from '../save/save-data';
import { HULL_EMISS, ENV_TEMP } from '../dynamic/dynamic-motion';
import { DebrisPiece } from '../dynamic/dynamic-entity/debris-piece';
import {
  BARREL_RADIATING_AREA_PER_MASS, BARREL_SPECIFIC_HEAT,
} from '../dynamic/dynamic-entity/debris-motion';
import { CASING_COLLISION_BOUND_RADIUS } from '../dynamic/dynamic-entity/casing-collision';
import { sunGlareSpreadScale } from '../combat/sun-glare-spread';
import { WeaponState, type AmmoConsumption, type WeaponFireCommand } from './weapon-state';
import type { ProjectileEmitter } from './projectile-emitter';
import { DefaultWeaponEffects, type WeaponEffects } from './weapon-effects';

const BARREL_PHYS_RADIUS = 0.8;
const EJECTED_MAG_PHYS_RADIUS = 1.4;

const GUN_HEAT_PER_ROUND = 5.5e5; // 1発あたりに外殻へ入る熱量 [J]

// 1発あたりに砲身へ入る熱量 [J]。発射ガスの熱の大半は砲身の側が受け取る。
const GUN_BARREL_HEAT_PER_ROUND = 1.0e6;

const BARREL_MASS = 300; // [kg]

const SPINUP_TIME = 0.15; // 発射開始から実際に撃ち始めるまでの起動遅延 [s]
const BULLET_SPREAD = 0.002; // 散布界 [rad]

const BULLET_LIFETIME = 240; // 保険としての寿命 [sim s]
const RECOIL_DV = 0.04; // 反動 [m/s]

const RELOAD_TIME = 1.0; // 手動/自動リロード(バレル交換)のクールダウン [s]

// 艦の初期積載(予備マガジン数・装填済み残弾数)。
export type AmmoLoad = { readonly mags: number; readonly rounds: number };

// スナップショットからの復元か、新規配置の初期積載か。どちらも省略すればフィールド初期化子の
// 既定積載で始まる。
type FireInit =
  | { readonly saved: FireSaveData }
  | { readonly ammo?: AmmoLoad };

export class FireControl {
  private readonly weapon: WeaponState;
  private readonly effects: WeaponEffects;

  // 装着している砲身の平均温度 [K] と、薬室側が平均より高い温度差 [K]。交換で切り離すときに
  // そのまま排出されるデブリへ移る。
  // 復元するスナップショットか、新規配置の初期積載を受け取る。どちらも省略すれば既定積載。
  constructor(
    private readonly player: Player,
    private readonly _notifier: Notifier,
    private readonly _worldSfx: WorldSfx,
    private readonly _scene: THREE.Scene,
    private readonly _fx: FlashEffects,
    init: FireInit = {},
  ) {
    this.weapon = new WeaponState(
      'saved' in init ? init.saved : undefined,
      'ammo' in init && init.ammo ? init.ammo : undefined,
    );
    this.effects = new DefaultWeaponEffects(_worldSfx, _fx);
  }

  public get rounds(): number { return this.weapon.rounds; }
  public get mags(): number { return this.weapon.mags; }
  public get barrel(): number { return this.weapon.barrel; }
  public get cooldown(): number { return this.weapon.cooldown; }
  get isFiring(): boolean { return this.weapon.wasFiring; }

  get left(): boolean { return this.weapon.left; }

  // 弾薬・砲身の状態をスナップショットへ落とす。
  serialize(): FireSaveData {
    return this.weapon.serialize() as FireSaveData;
  }

  // 拾ったマガジン数を加算する。弾切れ中なら即座に1マガジンを装填する。
  onPickup(mags: number): void {
    if (!Number.isFinite(mags) || mags <= 0) return;
    this.weapon.addMags(mags);
  }

  // 発射状態を強制的に解除する。
  stopFiring(): void {
    this.weapon.wasFiring = false;
  }

  // 発射入力を1フレーム分処理する。トリガーが引かれ、ワープ速度・弾薬が許せば発射する。
  updateFireState(
    dt: number,
    input: Input,
    activeStage: StageOutcome,
    registry: EntityRegistry,
    celestialBodies: CelestialBodies,
  ): void {
    this.tickReloadTimer(dt);

    const keyHeld = input.down(K.fire);
    if (!keyHeld) {
      // トリガーを離した時点で連射状態を畳む: wasFiring を立てたままにすると
      // fineAttitude(微調整出力)が恒久的に有効なままになり、次にトリガーを
      // 引いたときもスピンアップ演出(justStartedFiring)が起きなくなる。
      this.weapon.wasFiring = false;
      return;
    }

    if (this.player.totalFireRate <= 0) {
      if (!this.weapon.wasEmptyClick) {
        this.effects.emptyClick();
        this._notifier.hint('武装が損傷しており発射できない', 3000);
        this.weapon.wasEmptyClick = true;
      }
      return;
    }

    if (!this.left) {
      if (!this.weapon.wasEmptyClick) {
        this.effects.emptyClick();
        this._notifier.hint('弾薬切れ — 軌道上の補給 ▣ を回収せよ', 3000);
        this.weapon.wasEmptyClick = true;
      }
      return;
    }

    const projectileEmitter: ProjectileEmitter = { emit: projectile => registry.add(projectile) };
    this.fireCycle(activeStage, registry, projectileEmitter, celestialBodies);
  }

  // クールダウンタイマーを dt だけ減らす。
  private tickReloadTimer(dt: number): void {
    this.weapon.tickCooldown(dt);
  }

  // クールダウン込みの発射サイクルを1回進める。スピンアップ中・クールダウン中は発射しない。
  private fireCycle(
    activeStage: StageOutcome,
    registry: EntityRegistry,
    projectileEmitter: ProjectileEmitter,
    celestialBodies: CelestialBodies,
  ): void {
    const justStartedFiring = !this.weapon.wasFiring;
    this.weapon.wasFiring = true;
    this.weapon.wasEmptyClick = false;

    // 起動時のタイムラグ
    if (justStartedFiring) {
      this.effects.spinUp();
      this.weapon.cooldown = SPINUP_TIME;
      return;
    }

    // 起動時及びクールダウン中は発射しない
    if (0 < this.weapon.cooldown) {
      return;
    }

    const command = this.weapon.beginShot(PLAYER_MUZZLE_OFFSETS.length);
    if (command === null) return;

    this.fireGun(command, activeStage, registry, projectileEmitter, celestialBodies);
    switch (command.consumption) {
      case 'empty':
      case 'normal':
        this.weapon.cooldown = 1 / this.player.totalFireRate;
        return;
      case 'mag-reload':
        this.spawnEjectedMagazineFrame(this.player, registry);
        this.effects.magFeed();
        this.weapon.cooldown = 1 / this.player.totalFireRate;
        return;
      case 'barrel-reload':
        this.spawnEjectedMagazineFrame(this.player, registry);
        this.weapon.cooldown = RELOAD_TIME;
        this.dropBarrel(this.player, registry);
        this.effects.reload();
        return;
    }
  }

  // 1発の消費を試みる。マガジンを撃ち尽くしたら次のマガジンへ(mag-reload)、
  // バレル内の全マガジンを撃ち尽くしたらバレル交換(barrel-reload)を報告する。
  consume(): AmmoConsumption {
    return this.weapon.consume();
  }

  // 手動リロードを試みる。開始できたら true。
  manualReload(registry: EntityRegistry): boolean {
    if (this.weapon.cooldown > 0) return false;

    // 予備マガジンがあり、かつ装填中のマガジンに実際に補充の余地があるときだけリロードする
    if (!this.weapon.manualReload()) return false;
    this.weapon.cooldown = RELOAD_TIME;
    this.effects.reload();
    this.dropBarrel(this.player, registry);
    return true;
  }

  // ---------------------------------------------------------------- entity管理

  // 1発発射する: 弾丸・薬莢・マズルフラッシュを生成し、発射数を記録する。
  private fireGun(
    command: WeaponFireCommand,
    activeStage: StageOutcome,
    registry: EntityRegistry,
    projectileEmitter: ProjectileEmitter,
    celestialBodies: CelestialBodies,
  ): void {
    const fwd = qRotate(this.player.motion.att.q, LOCAL_FORWARD);

    // 縦二連の砲口から交互に発射する
    const mo = PLAYER_MUZZLE_OFFSETS[command.muzzleIndex]!;
    const muzzle = add(
      this.player.motion.state.r,
      qRotate(this.player.motion.att.q, v3(mo.x, mo.y, mo.z)),
    );

    this.spawnBullet(this.player, muzzle, fwd, projectileEmitter, celestialBodies);
    // 反動(運動量保存の風味): 発射方向と逆に微小 Δv(瞬間的な速度変更なので時刻は据え置き)
    this.player.motion.state = kinematicState<'eci'>(
      this.player.motion.state.t,
      this.player.motion.state.r,
      addScaled(this.player.motion.state.v, fwd, -RECOIL_DV),
    );
    this.dropCasing(this.player, muzzle, registry);
    this.spawnMuzzleFlash(this.player, muzzle, fwd);

    activeStage.scoreCounter.recordShot();
    this.player.motion.absorbHeat(GUN_HEAT_PER_ROUND / Math.max(this.player.motion.mass, 1e-9));
    this.weapon.pendingBarrelJoules += GUN_BARREL_HEAT_PER_ROUND;
    this.effects.fire();
  }

  // 弾丸: 機首方向 + 散布界
  private spawnBullet(
    ship: Ship, muzzle: Vec3, fwd: Vec3, emitter: ProjectileEmitter, celestialBodies: CelestialBodies,
  ): void {
    const sunDir = celestialBodies.sunDirFrom(ship.motion.state.r, ship.motion.state.t);
    const spreadScale = sunGlareSpreadScale(muzzle, fwd, sunDir, R_EARTH_EQ);
    // 機首方向に散布角を加えた発射方向
    const spread = Math.abs(randSym(BULLET_SPREAD)) * spreadScale;
    const dir = norm(addScaled(fwd, randPerp(fwd), spread));
    const bullet = new Bullet(
      kinematicState<'eci'>(
        ship.motion.state.t,
        addScaled(muzzle, fwd, 1.5),
        addScaled(ship.motion.state.v, dir, ship.averageMuzzleVelocity),
      ),
      BULLET_LIFETIME,
      'player',
      'normal',
      ship.weaponDamage,
      this._worldSfx,
    );
    emitter.emit(bullet);
  }

  // 薬莢: -X 側へ排出(+X 側はマガジンベルトの給弾があるため)。
  // 初速は抑えてゆっくり漂わせる一方、回転速度は個体ごとに大きくばらつかせる。
  private dropCasing(ship: Ship, muzzle: Vec3, registry: EntityRegistry): void {
    // 機体姿勢基準の左右・上方向
    const right = qRotate(ship.motion.att.q, LOCAL_RIGHT);
    const up = qRotate(ship.motion.att.q, LOCAL_UP);
    registry.add(new DebrisPiece(
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
      this._worldSfx, this._fx, CASING_COLLISION_BOUND_RADIUS, this._scene,
    ));
  }

  // マズルフラッシュ: 発射した側の砲口の少し先に出す。
  private spawnMuzzleFlash(ship: Ship, muzzle: Vec3, fwd: Vec3): void {
    this.effects.muzzleFlash(kinematicState<'eci'>(
      ship.motion.state.t, addScaled(muzzle, fwd, 1.2), ship.motion.state.v,
    ));
  }

  // 装着している砲身の温度を dt だけ進める。発砲で入った熱は刻みの分け方に依らず一度だけ
  // 温度へ変わり、薬室側には平均の 2 倍の温度上昇として乗る(SPEC/FLIGHT.md「熱管理」)。
  stepBarrelThermal(dt: number): void {
    // 放射で冷え、温度差は薄まる。
    const cooling = radiativeCooling(
      this.weapon.barrelTemperature, ENV_TEMP, HULL_EMISS, BARREL_RADIATING_AREA_PER_MASS,
      BARREL_SPECIFIC_HEAT, dt);
    this.weapon.barrelTemperature = stepTemperature(
      this.weapon.barrelTemperature, -cooling, BARREL_SPECIFIC_HEAT, dt);
    this.weapon.barrelDeviation = stepThermalDeviation(
      this.weapon.barrelDeviation, this.weapon.barrelTemperature, HULL_EMISS,
      BARREL_RADIATING_AREA_PER_MASS, BARREL_SPECIFIC_HEAT, dt);
    // 溜まっていた発射ガスの熱を、この区間で一度だけ温度へ変える。
    if (this.weapon.pendingBarrelJoules === 0) return;
    const rise = this.weapon.pendingBarrelJoules / (BARREL_MASS * BARREL_SPECIFIC_HEAT);
    this.weapon.barrelTemperature += rise;
    this.weapon.barrelDeviation += rise;
    this.weapon.pendingBarrelJoules = 0;
  }

  // バレル交換時に円柱アイテムをデブリとして放出する。装着していた砲身の温度は、そのまま
  // 排出されたデブリへ移る。
  dropBarrel(ship: Ship, registry: EntityRegistry): void {
    // 下方に少し勢いをつけて放出
    const down = qRotate(ship.motion.att.q, v3(0, -1, 0));
    registry.add(new DebrisPiece(
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
      this._worldSfx, this._fx, BARREL_PHYS_RADIUS, this._scene,
    ));
    this.weapon.barrelTemperature = ENV_TEMP;
    this.weapon.barrelDeviation = 0;
    this.weapon.pendingBarrelJoules = 0;
  }

  // マガジン1個を撃ち尽くした瞬間、-X 側(薬莢と同じ側)の位置から
  // 空になったマガジンの外枠(弾なし)をデブリとして放出する。
  private spawnEjectedMagazineFrame(ship: Ship, registry: EntityRegistry): void {
    // 排出ポートの位置と初速
    const right = qRotate(ship.motion.att.q, LOCAL_RIGHT);
    const portWorld = add(
      ship.motion.state.r, qRotate(ship.motion.att.q, v3(-0.9, 0, 0)),
    );
    registry.add(new DebrisPiece(
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
      this._worldSfx, this._fx, EJECTED_MAG_PHYS_RADIUS, this._scene,
    ));
  }
}
