// 自機の電力、可変質量、マーカー ID、弾薬・セーブ値の境界を検証する。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { Q_IDENTITY } from '../../src/math/quat';
import { v3 } from '../../src/math/vec3';
import { kinematicState } from '../../src/physics/kinematic-state';
import { DynamicMotion } from '../../src/game/dynamic/dynamic-motion';
import { Ship, SHIP_BCINV, SHIP_SRP_COEFF } from '../../src/game/dynamic/dynamic-entity/ship';
import { partFromSaveData } from '../../src/game/dynamic/dynamic-entity/parts';
import { DynamicView } from '../../src/render/dynamic/dynamic-view';
import { FireControl } from '../../src/game/player/fire-control';
import { WeaponState } from '../../src/game/player/weapon-state';
import { DeployablePanelState } from '../../src/game/player/deployable-panel-state';
import { PlayerMotion, type PlayerMotionReactions } from '../../src/game/player/player-motion';
import { PowerSystem, POWER_CAPACITY } from '../../src/game/player/power';
import { RadiatorSystem } from '../../src/game/player/radiator';
import { Throttle, THROTTLE_LEVELS } from '../../src/game/player/throttle';
import type { FireSaveData, ThrottleSaveData } from '../../src/game/save/save-data';
import type { Player } from '../../src/game/player/player';
import type { Notifier } from '../../src/hud/notifier';

const attitude = { q: Q_IDENTITY, w: v3(), inertia: v3(1, 1, 1) };
const state = kinematicState<'eci'>(0, v3(), v3());
const quietNotifier: Notifier = { hint() {}, toast() {} };

class TestShip extends Ship {
  public constructor(name: string) {
    super(name, 100, () => new DynamicMotion(state, { mass: 1_000 }), new NullView());
  }

  public rename(name: string): void { this.setName(name); }
}

class NullView extends DynamicView {
  public constructor() {
    super(new THREE.Object3D(), undefined, false);
  }
}

function reactions(): PlayerMotionReactions {
  return {
    weapon: { roundsInMagazine: () => 0, stepBarrelThermal: () => {} },
    environment: {
      thrustAcceleration: () => v3(),
      radiatorWear: () => ({ up: 0, down: 0 }),
      totalCoolingRate: () => 84,
      totalPowerGeneration: () => 0,
    },
    altitudeAlarm: { updateAltitudeAlarm: () => {} },
    contact: {
      receiveEntityContact: () => {},
      receiveRadiatorContact: () => {},
      receiveSurfaceContact: () => {},
    },
    loss: { receiveStructuralLoss: () => {}, receiveBurnUp: () => {} },
  };
}

export function register(): void {
  test('player power: installedGeneration=0 は全損として発電しない', () => {
    const power = new PowerSystem();
    const start = power.chargeJ;
    power.update(1, 1, v3(0, 1, 0), attitude, 0);
    assert.equal(power.chargeJ, start);

    const defaultPower = new PowerSystem();
    defaultPower.update(1, 1, v3(0, 1, 0), attitude);
    assert.ok(defaultPower.chargeJ > start);
  });

  test('player motion: 接続ブースターの質量で空力・輻射圧の質量あたり値が下がる', () => {
    const motion = new PlayerMotion(state, attitude, 2.6, 300, 0, reactions());
    motion.attachedBoosters.attach({
      id: 'test-booster', dryMass: 200, fuel: 800, maxFuel: 800,
      thrust: 600_000, fuelRate: 80, ignited: false,
    });
    assert.equal(motion.mass, 2_000);
    assert.equal(motion.bcInv, SHIP_BCINV / 2);
    assert.equal(motion.srpCoeff, SHIP_SRP_COEFF / 2);
  });

  test('ship marker: 同名艦でも clipPath ID が衝突せず、改名でも安定する', () => {
    const first = new TestShip('same-name');
    const second = new TestShip('same-name');
    const clipId = (svg: string): string => /<clipPath id="([^"]+)">/.exec(svg)?.[1] ?? '';
    const firstId = clipId(first.headingHpMarkerSvg());
    const secondId = clipId(second.headingHpMarkerSvg());
    assert.notEqual(firstId, '');
    assert.notEqual(firstId, secondId);
    first.rename('renamed');
    assert.equal(clipId(first.headingHpMarkerSvg()), firstId);
  });

  test('player save: 電力・放熱板・スロットル・パーツの不正値を安全な状態へ正規化する', () => {
    assert.equal(new PowerSystem({ charge: Number.NaN }).chargeJ, POWER_CAPACITY * 0.75);
    assert.equal(new PowerSystem({ charge: POWER_CAPACITY * 2 }).chargeJ, POWER_CAPACITY);

    const radiator = new RadiatorSystem(new DynamicMotion(state), () => {}, {
      up: { deployTarget: 7 as 0 | 1, deploy: Number.NaN },
      down: { deployTarget: 0, deploy: 2 },
    });
    assert.equal(radiator.deployOf('up'), 0);
    assert.equal(radiator.deployOf('down'), 1);

    const throttle = new Throttle(quietNotifier, {
      throttleIdx: 99,
      rcsDamp: 'bad' as unknown as boolean,
      progradeHold: null as unknown as boolean,
    } satisfies ThrottleSaveData);
    assert.equal(throttle.throttleIdx, 1);
    throttle.setThrottlePreset(-1);
    assert.equal(throttle.throttleIdx, 1);
    throttle.setThrottlePreset(THROTTLE_LEVELS.length);
    assert.equal(throttle.throttleIdx, 1);

    const part = partFromSaveData({
      id: 'bad-part', type: 'hull', name: 'bad', weight: 100, maxHp: Number.NaN, hp: Number.POSITIVE_INFINITY,
    });
    assert.ok(part);
    assert.equal(part.maxHp, 1);
    assert.equal(part.hp, 0);
  });

  test('fire control: 非正数の補給と不正な保存値を安全な状態へ正規化する', () => {
    const fire = new FireControl(
      { motion: { mass: 1_000 } } as Player,
      quietNotifier,
      {} as never,
      {} as never,
      {} as never,
      { saved: {
        mags: -2, rounds: 999, barrel: -1, cooldown: Number.NaN, muzzleIdx: 8,
      } as FireSaveData },
    );
    assert.equal(fire.mags, 2);
    assert.equal(fire.rounds, 32);
    assert.equal(fire.barrel, 3);
    const before = fire.mags;
    fire.onPickup(0);
    fire.onPickup(-1);
    assert.equal(fire.mags, before);
  });

  test('weapon state: 弾薬遷移と砲口交互状態は副作用なしに再現できる', () => {
    const weapon = new WeaponState(undefined, { mags: 1, rounds: 1 });
    const first = weapon.beginShot(2);
    assert.deepEqual(first, { consumption: 'mag-reload', muzzleIndex: 0 });
    const second = weapon.beginShot(2);
    assert.deepEqual(second, { consumption: 'normal', muzzleIndex: 1 });
    assert.equal(weapon.muzzleIdx, 0);
  });

  test('deployable panel: 展開目標と補間値は電力・放熱の性能から独立して進む', () => {
    const panel = new DeployablePanelState(0, 0);
    panel.toggle();
    panel.update(0.5, 1);
    assert.equal(panel.target, 1);
    assert.equal(panel.value, 0.5);
    panel.setTarget(false);
    panel.update(1, 1);
    assert.equal(panel.value, 0);
  });
}
