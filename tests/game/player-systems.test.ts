// 自機の電力、可変質量、マーカー ID、弾薬・セーブ値の境界を検証する。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { Q_IDENTITY } from '../../src/math/quat';
import { v3 } from '../../src/math/vec3';
import { stepAttitude } from '../../src/physics/attitude';
import { kinematicState } from '../../src/physics/kinematic-state';
import { DynamicMotion } from '../../src/game/dynamic/dynamic-motion';
import type { FuelConsumer } from '../../src/game/dynamic/dynamic-entity/controllable';
import { Ship, SHIP_BCINV, SHIP_SRP_COEFF } from '../../src/game/dynamic/dynamic-entity/ship';
import type { PilotControls } from '../../src/game/dynamic/dynamic-entity/pilot-controls';
import { createShipDefaultParts } from '../../src/game/dynamic/dynamic-entity/ship-default-parts';
import { DynamicView } from '../../src/render/dynamic/dynamic-view';
import { FireControl } from '../../src/game/player/fire-control';
import { Throttle } from '../../src/game/player/throttle';
import { WeaponState, type SerializedWeaponState } from '../../src/game/player/weapon-state';
import { DeployablePanelState } from '../../src/game/player/deployable-panel-state';
import { PowerSystem, POWER_CAPACITY } from '../../src/game/player/power';
import { RadiatorSystem } from '../../src/game/player/radiator';
import type { ModularShip } from '../../src/game/ship/modular-ship';
import { ModularShipMotion } from '../../src/game/ship/modular-ship-motion';
import { createDefaultCombatPreset } from '../../src/game/ship/ship-presets';
import { createShipModuleInstance } from '../../src/game/ship/ship-module-instance';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import type { SerializedDynamicEntity } from '../../src/game/dynamic/dynamic-entity/entity-dictionary';

const attitude = { q: Q_IDENTITY, w: v3(), inertia: v3(1, 1, 1) };
const state = kinematicState<'eci'>(0, v3(), v3());

class TestShip extends Ship {
  public constructor(name: string, id = 'test-ship') {
    super(
      name, 1_000, () => new DynamicMotion(state, { mass: 1_000 }), new NullView(),
      id, createShipDefaultParts(1_000),
    );
  }

  public rename(name: string): void { this.setName(name); }

  // 試験用の艦には直列化した形の種別が無いので、呼ぶと例外を投げる。
  public override serialize(): SerializedDynamicEntity {
    throw new Error('TestShip は直列化できない');
  }
}

class NullView extends DynamicView {
  public constructor() {
    super(new THREE.Object3D(), undefined, false);
  }
}

export function register(): void {
  test('default ship: 固定ロードアウトの集計値を維持する', () => {
    const ship = new TestShip('default');

    // FLIGHT.md の既定船: HP 1,000、既定部品の出力・資源・装備を合計した値。
    assert.equal(ship.hp, 1_000);
    assert.equal(ship.maxHp, 1_000);
    assert.equal(ship.totalThrust, 400_000);
    assert.ok(Math.abs(ship.totalTorque - 24_000) < 1e-12);
    assert.equal(ship.totalFuel, 1_000);
    assert.equal(ship.totalMaxFuel, 1_000);
    assert.equal(ship.totalFuelConsumptionRate, 1);
    assert.equal(ship.totalPowerGeneration, 1_650);
    assert.equal(ship.totalCoolingRate, 9.6);
    assert.equal(ship.weaponDamage, 1);
    assert.equal(ship.totalFireRate, 1 / 0.06);
    assert.equal(ship.averageMuzzleVelocity, 1_000);
  });

  test('default ship: 実慣性に対して RCS が姿勢を変える角加速度を出す', () => {
    const assembly = createDefaultCombatPreset();
    const totals = assembly.totals();
    const motion = new ModularShipMotion(assembly, state, attitude);
    const throttle = new Throttle(1, false, false);
    const controls: PilotControls = {
      thrust: new Set(), rotation: new Set(['rollRight']), firing: false, commands: [],
    };
    const fuelConsumer: FuelConsumer = {
      totalThrust: assembly.totalThrust,
      totalTorque: assembly.totalTorque,
      totalFuelConsumptionRate: 1,
      totalFuel: totals.mainFuel,
      totalMaxFuel: totals.maxMainFuel,
      motion,
      consumeFuel: () => 1,
      consumeRcsFuel: () => 1,
    };

    throttle.updateTorque(motion.att, v3(), v3(), controls, false, 0, 0, fuelConsumer, null);
    const angularAcceleration = throttle.torque.z / motion.att.inertia.z;
    assert.ok(angularAcceleration > 0.45 && angularAcceleration < 0.6);

    const next = stepAttitude(motion.att, throttle.torque, 0.4);
    assert.ok(Math.abs(next.q.z) > 1e-3);
  });

  test('player power: installedGeneration=0 は全損として発電しない', () => {
    const power = new PowerSystem();
    const start = power.chargeJ;
    power.update(1, 1, v3(0, 1, 0), attitude, 0);
    assert.equal(power.chargeJ, start);

    const defaultPower = new PowerSystem();
    defaultPower.update(1, 1, v3(0, 1, 0), attitude);
    assert.ok(defaultPower.chargeJ > start);
  });

  test('player systems: deploy state は solar/radiator の module ID を保持する', () => {
    const assembly = createDefaultCombatPreset();
    const power = new PowerSystem(undefined, undefined, undefined, assembly);
    power.syncAssembly();
    power.setDeployed('solar-right', false);
    power.update(3, 0, v3(0, 1, 0), attitude);
    assert.equal(power.deployOf('solar-left'), 1);
    assert.equal(power.deployOf('solar-right'), 0);
    assert.deepEqual(power.serialize().panels?.map(panel => panel.id), ['solar-left', 'solar-right']);

    const radiator = new RadiatorSystem(new DynamicMotion(state), () => {}, undefined, undefined, assembly);
    radiator.syncAssembly();
    radiator.setDeployed('radiator', true);
    assert.equal(radiator.deployOf('radiator'), 0);
    radiator.update(3, {});
    assert.equal(radiator.deployOf('radiator'), 1);
    assert.equal(radiator.radiatingArea(0), 4.8);
    assert.deepEqual(radiator.serialize().panels?.map(panel => panel.id), ['radiator']);
  });

  test('modular ship motion: booster module の質量で空力・輻射圧の質量あたり値が下がる', () => {
    const assembly = createDefaultCombatPreset();
    assembly.append(createShipModuleInstance(
      SHIP_MODULE_CATALOG.require('booster-standard'), 'test-booster',
    ));
    const motion = new ModularShipMotion(assembly, state, attitude);
    assert.equal(motion.mass, 1_990);
    assert.equal(motion.bcInv, SHIP_BCINV * 1_000 / 1_990);
    assert.equal(motion.srpCoeff, SHIP_SRP_COEFF * 1_000 / 1_990);
  });

  test('ship marker: 同名艦でも clipPath ID が衝突せず、改名でも安定する', () => {
    const first = new TestShip('same-name', 'entity-1');
    const second = new TestShip('same-name', 'entity-2');
    const clipId = (svg: string): string => /<clipPath id="([^"]+)">/.exec(svg)?.[1] ?? '';
    const firstId = clipId(first.headingHpMarkerSvg());
    const secondId = clipId(second.headingHpMarkerSvg());
    assert.notEqual(firstId, '');
    assert.notEqual(firstId, secondId);
    first.rename('renamed');
    assert.equal(clipId(first.headingHpMarkerSvg()), firstId);
  });

  test('player save: 電力・放熱板の不正値を安全な状態へ正規化する', () => {
    const powerOf = (charge: number): PowerSystem => PowerSystem.deserialize({
      charge, up: { deployTarget: 1, deploy: 1 }, down: { deployTarget: 1, deploy: 1 }, panels: null,
    });
    assert.equal(powerOf(POWER_CAPACITY * 2).chargeJ, POWER_CAPACITY);

    // 壊れた記録は持ち主の初期値(放熱板は収納)で補い、範囲外の展開度は収める。
    const radiator = new RadiatorSystem(
      new DynamicMotion(state), () => {},
      DeployablePanelState.deserialize({ deployTarget: 7 as 0 | 1, deploy: Number.NaN }) ?? undefined,
      DeployablePanelState.deserialize({ deployTarget: 0, deploy: 2 }) ?? undefined,
    );
    assert.equal(radiator.deployOf('up'), 0);
    assert.equal(radiator.deployOf('down'), 1);
    // 太陽電池の初期値は展開。
    const power = PowerSystem.deserialize({
      charge: 0, up: { deployTarget: 7 as 0 | 1, deploy: Number.NaN }, down: { deployTarget: 1, deploy: 1 }, panels: null,
    });
    assert.equal(power.serialize().up.deploy, 1);
  });

  test('fire control: 非正数の補給と不正な保存値を安全な状態へ正規化する', () => {
    const weapon = WeaponState.deserialize({
      mags: -2, rounds: 999, cooldown: Number.NaN, muzzleIdx: -1,
      wasFiring: false, wasEmptyClick: false,
    } satisfies SerializedWeaponState);
    const fire = new FireControl(
      { motion: { mass: 1_000 } } as ModularShip,
      {} as never,
      {} as never,
      weapon,
    );
    assert.equal(fire.mags, 2);
    assert.equal(fire.rounds, 32);
    const before = fire.mags;
    fire.onPickup(0);
    fire.onPickup(-1);
    assert.equal(fire.mags, before);
  });

  test('weapon state: 弾薬遷移と砲口交互状態は副作用なしに再現できる', () => {
    const weapon = WeaponState.create({ mags: 1, rounds: 1 });
    assert.deepEqual(weapon.nextShot(2), { consumption: 'mag-reload', muzzleIndex: 0 });
    weapon.fire(2);
    assert.deepEqual(weapon.nextShot(2), { consumption: 'normal', muzzleIndex: 1 });
    weapon.fire(2);
    assert.equal(weapon.muzzleIdx, 0);
  });
}
