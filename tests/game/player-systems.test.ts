// 自機の電力、可変質量、マーカー ID、弾薬・セーブ値の境界を検証する。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { Q_IDENTITY } from '../../src/math/quat';
import { v3 } from '../../src/math/vec3';
import { kinematicState } from '../../src/physics/kinematic-state';
import { DynamicMotion } from '../../src/game/dynamic/dynamic-motion';
import { Ship } from '../../src/game/dynamic/dynamic-entity/ship';
import { SHIP_BCINV, SHIP_SRP_COEFF } from '../../src/game/dynamic/dynamic-entity/vessel';
import { DynamicView } from '../../src/render/dynamic/dynamic-view';
import { FireControl } from '../../src/game/player/fire-control';
import { WeaponState } from '../../src/game/player/weapon-state';
import { DeployablePanelState } from '../../src/game/player/deployable-panel-state';
import { PlayerMotion, type PlayerMotionReactions } from '../../src/game/player/player-motion';
import { PowerSystem, POWER_CAPACITY } from '../../src/game/player/power';
import { RadiatorSystem } from '../../src/game/player/radiator';
import type { Player } from '../../src/game/player/player';
import type { SerializedDynamicEntity } from '../../src/game/dynamic/dynamic-entity/entity-dictionary';

const attitude = { q: Q_IDENTITY, w: v3(), inertia: v3(1, 1, 1) };
const state = kinematicState<'eci'>(0, v3(), v3());

class TestShip extends Ship {
  // 識別子は本番では採番器が配るので、テストでも名前とは別に与える。
  public constructor(name: string, id: string) {
    super(name, 100, () => new DynamicMotion(state, { mass: 1_000 }), new NullView(), id);
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
    const motion = new PlayerMotion(
      state, attitude, 2.6, 0, reactions(), { temperature: 300, thermalDeviation: 0, pendingSpecificHeat: 0 },
    );
    motion.attachedBoosters.attach({
      id: 'test-booster', dryMass: 200, fuel: 800, maxFuel: 800,
      thrust: 600_000, fuelRate: 80, ignited: false,
    });
    assert.equal(motion.mass, 2_000);
    assert.equal(motion.bcInv, SHIP_BCINV / 2);
    assert.equal(motion.srpCoeff, SHIP_SRP_COEFF / 2);
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
      charge, up: { deployTarget: 1, deploy: 1 }, down: { deployTarget: 1, deploy: 1 },
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
      charge: 0, up: { deployTarget: 7 as 0 | 1, deploy: Number.NaN }, down: { deployTarget: 1, deploy: 1 },
    });
    assert.equal(power.serialize().up.deploy, 1);
  });

  test('fire control: 非正数の補給ではマガジンが増えない', () => {
    const fire = new FireControl({ motion: { mass: 1_000 } } as Player, {} as never, {} as never);
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
