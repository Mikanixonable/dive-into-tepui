// 自機の電力、可変質量、マーカー ID、弾薬・セーブ値の境界を検証する。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { Q_IDENTITY } from '../../src/math/quat';
import { add, addScaled, len, sub, v3, type Vec3 } from '../../src/math/vec3';
import { stepAttitude } from '../../src/physics/attitude';
import { kinematicState } from '../../src/physics/kinematic-state';
import { DynamicMotion } from '../../src/game/dynamic/dynamic-motion';
import type { FuelConsumer } from '../../src/game/dynamic/entity/controllable';
import {
  CombatShipEntity, SHIP_BCINV, SHIP_SRP_COEFF,
} from '../../src/game/dynamic/entity/combat-ship-entity';
import type { PilotControls } from '../../src/game/dynamic/entity/pilot-controls';
import { DynamicView } from '../../src/render/dynamic/dynamic-view';
import { FireControl } from '../../src/game/player/fire-control';
import { Throttle } from '../../src/game/player/throttle';
import { ammoTotals, consumeRound, supplyMagazines, swapMagazine } from '../../src/game/player/gun-magazine';
import { Bullet } from '../../src/game/dynamic/entity/bullet';
import { EntityIdAllocators } from '../../src/game/dynamic/entity/entity-id';
import type { EntityRegistry } from '../../src/game/dynamic/entity-registry';
import type { RunEventBody } from '../../src/game/run-events';
import type { StageOutcome } from '../../src/game/stages/stage-outcome';
import type { CelestialBodies } from '../../src/game/celestial/celestial-bodies';
import type { WeaponPorts } from '../../src/game/ship/ship-capabilities';
import { MAG_ROUNDS } from '../../src/game/player/ammo-spec';
import { DeployablePanelState } from '../../src/game/player/deployable-panel-state';
import { PowerSystem, POWER_CAPACITY } from '../../src/game/player/power';
import { RadiatorSystem } from '../../src/game/player/radiator';
import type { ModularShip } from '../../src/game/ship/modular-ship';
import { ModularShipMotion } from '../../src/game/ship/modular-ship-motion';
import { createDefaultCombatPreset, createSalvageTenderPreset } from '../../src/game/ship/ship-presets';
import { createShipModuleInstance } from '../../src/game/ship/ship-module-instance';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import type { SerializedDynamicEntity } from '../../src/game/dynamic/entity/entity-dictionary';

const attitude = { q: Q_IDENTITY, w: v3(), inertia: v3(1, 1, 1) };
const state = kinematicState<'eci'>(0, v3(), v3());

class TestShip extends CombatShipEntity {
  // 既定部品と固定の運動状態で組む。
  public constructor(name: string, id = 'test-ship') {
    super(
      name, 1_000, () => new DynamicMotion(state, { mass: 1_000 }), new NullView(),
      id,
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
    assert.ok(angularAcceleration > 0.3 && angularAcceleration < 0.4,
      `RCS roll acceleration ${angularAcceleration} rad/s²`);

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

  test('player systems: 未装備の側の放熱板は損耗 0・展開 0 を返す', () => {
    // 標準戦闘艦は放熱板を1枚だけ積む。無い側を「損耗100%」と読むと、VESSEL パネルが
    // 積んでいない放熱板を赤い損耗表示にしてしまう。
    const assembly = createDefaultCombatPreset();
    const radiator = new RadiatorSystem(new DynamicMotion(state), () => {}, undefined, undefined, assembly);
    radiator.syncAssembly();
    assert.equal(radiator.deployOf('up'), 0);
    assert.equal(radiator.wearOf('up'), 0);
    assert.equal(radiator.deployOf('down'), 0);
    assert.equal(radiator.wearOf('down'), 0);
  });

  test('player systems: 展開部品の有無を hasPanels で問える', () => {
    // 標準戦闘艦は太陽電池2枚・放熱板1枚を積む。補給艇はどちらも積まない。
    const combat = createDefaultCombatPreset();
    const combatPower = new PowerSystem(undefined, undefined, undefined, combat);
    combatPower.syncAssembly();
    assert.equal(combatPower.hasPanels(), true);
    assert.equal(combatPower.hasPanel('up'), true);
    assert.equal(combatPower.hasPanel('down'), true);
    const combatRadiator = new RadiatorSystem(new DynamicMotion(state), () => {}, undefined, undefined, combat);
    combatRadiator.syncAssembly();
    assert.equal(combatRadiator.hasPanels(), true);
    assert.equal(combatRadiator.hasPanel('up'), true);
    assert.equal(combatRadiator.hasPanel('down'), false);

    const tender = createSalvageTenderPreset([]);
    const tenderPower = new PowerSystem(undefined, undefined, undefined, tender);
    tenderPower.syncAssembly();
    assert.equal(tenderPower.hasPanels(), false);
    assert.equal(tenderPower.hasPanel('up'), false);
    assert.equal(tenderPower.hasPanel('down'), false);
    const tenderRadiator = new RadiatorSystem(new DynamicMotion(state), () => {}, undefined, undefined, tender);
    tenderRadiator.syncAssembly();
    assert.equal(tenderRadiator.hasPanels(), false);
    assert.equal(tenderRadiator.hasPanel('up'), false);
    assert.equal(tenderRadiator.hasPanel('down'), false);

    // assembly を持たない旧式の経路は、既定の2枚を持つ。
    assert.equal(new PowerSystem().hasPanels(), true);
    assert.equal(new PowerSystem().hasPanel('up'), true);
    assert.equal(new PowerSystem().hasPanel('down'), true);
    assert.equal(new RadiatorSystem(new DynamicMotion(state), () => {}).hasPanels(), true);
    assert.equal(new RadiatorSystem(new DynamicMotion(state), () => {}).hasPanel('up'), true);
    assert.equal(new RadiatorSystem(new DynamicMotion(state), () => {}).hasPanel('down'), true);
  });

  test('player systems: 積んでいない側の展開切替は無操作', () => {
    // 標準戦闘艦は放熱板を1枚だけ積む。無い側の切替は、ある側の展開度を変えない。
    const combatRadiator = new RadiatorSystem(
      new DynamicMotion(state), () => {}, undefined, undefined, createDefaultCombatPreset(),
    );
    combatRadiator.syncAssembly();
    combatRadiator.toggle('down');
    assert.equal(combatRadiator.deployOf('down'), 0);
    assert.equal(combatRadiator.deployOf('up'), 0);
  });

  test('modular ship motion: booster module の質量で空力・輻射圧の質量あたり値が下がる', () => {
    const assembly = createDefaultCombatPreset();
    assembly.append(createShipModuleInstance(
      SHIP_MODULE_CATALOG.require('booster-standard'), 'test-booster',
    ));
    const motion = new ModularShipMotion(assembly, state, attitude);
    assert.equal(motion.mass, 2_030);
    assert.equal(motion.bcInv, SHIP_BCINV * 1_000 / 2_030);
    assert.equal(motion.srpCoeff, SHIP_SRP_COEFF * 1_000 / 2_030);
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

  test('gun magazine: 撃ち尽くしたマガジンは予備から継ぎ目なく装填し、予備が無ければ空になる', () => {
    const gun = { rounds: 1, mags: 1 };
    assert.equal(consumeRound(gun), 'mag-reload');
    assert.deepEqual(gun, { rounds: MAG_ROUNDS, mags: 0 });
    gun.rounds = 1;
    assert.equal(consumeRound(gun), 'normal');
    assert.deepEqual(gun, { rounds: 0, mags: 0 });
    assert.equal(consumeRound(gun), null);
  });

  test('gun magazine: 補給は予備の少ない砲から1本ずつ、残弾 0 の砲へはそのまま装填する', () => {
    const a = { rounds: 10, mags: 2 }, b = { rounds: 0, mags: 0 }, c = { rounds: 5, mags: 0 };
    supplyMagazines([a, b, c], 4);
    // b(予備0・残弾0)へ装填 → b と c が予備0で並び b が先 → c → b。
    assert.deepEqual([a, b, c], [{ rounds: 10, mags: 2 }, { rounds: MAG_ROUNDS, mags: 2 }, { rounds: 5, mags: 1 }]);
    supplyMagazines([a], -1);
    supplyMagazines([a], Number.NaN);
    assert.deepEqual(a, { rounds: 10, mags: 2 });
  });

  test('gun magazine: マガジン交換は予備があり補充の余地があるときだけ', () => {
    const full = { rounds: MAG_ROUNDS, mags: 2 }, empty = { rounds: 3, mags: 0 }, partial = { rounds: 3, mags: 1 };
    assert.equal(swapMagazine(full), false);
    assert.equal(swapMagazine(empty), false);
    assert.equal(swapMagazine(partial), true);
    assert.deepEqual(partial, { rounds: MAG_ROUNDS, mags: 0 });
    assert.deepEqual(ammoTotals([full, empty]), { rounds: MAG_ROUNDS + 3, mags: 2, capacity: 2 * MAG_ROUNDS });
  });

  test('fire control: 発射はフレームに縛られず、2門は連射間隔を等分した拍で撃つ', () => {
    const fired = fireForFrames(['g1', 'g2'], 1 / 30, 60);
    const interval = 0.06;
    // 起動遅延 0.15 s のあと 0.03 s ごと。30 fps でも1フレーム1発へ落ちない(毎秒 33.3 発)。
    assert.equal(fired.length, Math.floor((2 - 0.15) / (interval / 2) + 1e-9) + 1);
    fired.forEach((shot, i) => {
      assert.ok(Math.abs(shot.t - (0.15 + i * interval / 2)) < 1e-9, `shot ${i} at ${shot.t}`);
      assert.equal(shot.gun, i % 2 === 0 ? 'g1' : 'g2');
    });
  });

  test('fire control: 弾は撃った時刻に砲口の前に現れ、その前は砲身の中を直線に飛ぶ', () => {
    const fired = fireForFrames(['g1'], 1 / 60, 30);
    assert.ok(fired.length > 5);
    for (const shot of fired) {
      const { state } = shot.bullet.motion;
      assert.ok(state.t <= shot.t && shot.t - state.t < 1 / 60 + 1e-12);
      const at = addScaled(state.r, state.v, shot.t - state.t);
      // 撃った時刻の砲口(艦の速度で進めた位置)から前方 1.5 m に、散布界のぶんだけ外れて現れる。
      const muzzleAt = addScaled(v3(7e6, 0, 2.5), v3(0, 7600, 0), shot.t);
      assert.ok(len(sub(at, add(muzzleAt, v3(0, 0, 1.5)))) < 0.05, `offset ${len(sub(at, muzzleAt))}`);
      assert.equal(shot.bullet.motion.reaction.bornSim, shot.t);
    }
  });
}

// 砲 ids を積んだ艦の模型で、frameDt [s] のフレームを frames 回トリガーを引き続け、撃った時刻と砲と弾を
// 時刻の順に返す。
function fireForFrames(
  ids: readonly string[], frameDt: number, frames: number,
): { t: number; gun: string; bullet: Bullet }[] {
  const definition = SHIP_MODULE_CATALOG.require('weapon-gatling');
  const guns = ids.map((id) => createShipModuleInstance(definition, id));
  // 砲 k の砲口は x へ 10k m ずらし、発射の出来事の砲口の位置から撃った砲を引く。
  const ports: WeaponPorts[] = guns.map((gun, k) => ({
    moduleId: gun.id, muzzles: [v3(10 * k, 0, 2.5)], ejectionPort: v3(-2, 0, 0), linkExitPort: v3(-1, -2, 0),
    rotation: Q_IDENTITY,
  }));
  let t = 0;
  const shipVelocity = v3(0, 7600, 0);
  const origin = (): Vec3 => addScaled(v3(7e6, 0, 0), shipVelocity, t);
  const motion = {
    get state() { return kinematicState<'eci'>(t, origin(), shipVelocity); },
    att: { q: Q_IDENTITY, w: v3(), inertia: v3(1, 1, 1) },
    mass: 20_000,
    centerOffset: v3(),
    assemblyToEci: (p: Vec3) => add(origin(), p),
    applyImpulseAtPoint: () => {},
    absorbHeat: () => {},
  };
  const ship = {
    motion,
    capabilities: {
      modules: () => guns.map((gun) => ({ ...gun })),
      weaponPorts: () => ports,
      assembly: {
        definition: () => definition,
        module: (id: string) => ({ ...guns.find((gun) => gun.id === id)! }),
        setAmmo: (id: string, ammo: { rounds: number; mags: number }) => {
          Object.assign(guns.find((gun) => gun.id === id)!, { rounds: ammo.rounds, mags: ammo.mags });
        },
      },
    },
  } as unknown as ModularShip;
  const fired: { t: number; gun: string; bullet: Bullet }[] = [];
  const bullets: Bullet[] = [];
  const registry = {
    idAllocators: new EntityIdAllocators(),
    add: (entity: unknown) => { if (entity instanceof Bullet) bullets.push(entity); },
    events: {
      record: (body: RunEventBody) => {
        if (body.kind !== 'gunFired') return;
        const k = Math.round((body.muzzleState.r.x - 7e6) / 10);
        fired.push({ t: body.muzzleState.t, gun: ids[k]!, bullet: bullets[bullets.length - 1]! });
      },
    },
  } as unknown as EntityRegistry;
  const fire = FireControl.create(ship, registry, new THREE.Scene());
  const controls = { firing: true } as PilotControls;
  const stage = { recordShot: () => {} } as unknown as StageOutcome;
  const bodies = { starId: null } as unknown as CelestialBodies;
  for (let i = 0; i < frames; i++) {
    fire.updateFireState(frameDt, controls, stage, bodies);
    t += frameDt;
  }
  return fired;
}
