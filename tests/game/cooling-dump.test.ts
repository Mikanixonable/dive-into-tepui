// 主燃料の消費に比例する噴射冷却と、推力を伴わない冷却ダンプの挙動を検証する。
import * as assert from 'node:assert/strict';
import { Q_IDENTITY } from '../../src/math/quat';
import { v3 } from '../../src/math/vec3';
import type { Attitude } from '../../src/physics/attitude';
import { kinematicState } from '../../src/physics/kinematic-state';
import type { CelestialBody } from '../../src/physics/celestial-body';
import { fixedMotion, occludersOf } from '../physics/test-helpers';
import { MU_EARTH, R_EARTH } from '../../src/game/celestial/solar-system/earth-system';
import type { DynamicReactionServices } from '../../src/game/dynamic/dynamic-simulation-participant';
import { ShipAssembly } from '../../src/game/ship/ship-assembly';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import { createShipModuleInstance } from '../../src/game/ship/ship-module-instance';
import { ModularShipMotion } from '../../src/game/ship/modular-ship-motion';
import { CoolingDump } from '../../src/game/player/cooling-dump';
import { test } from '../harness';

// 噴射冷却の係数 [J/unit]。modular-ship-motion.ts の FUEL_COOLING_JOULES_PER_UNIT と同じ値。
const JOULES_PER_UNIT = 5e4;
// 冷却ダンプの流量 [unit/s]。cooling-dump.ts の COOLING_DUMP_FLOW_RATE と同じ値。
const DUMP_FLOW_RATE = 22.5;

function module(definitionId: string, id: string) {
  return createShipModuleInstance(SHIP_MODULE_CATALOG.require(definitionId), id);
}

// 操縦席 + tank-3-main(主燃料 80 単位)。RCS 側を試すときだけ tank-3-rcs を足す。
function ship(withRcsTank = false): ShipAssembly {
  const result = new ShipAssembly(SHIP_MODULE_CATALOG, true);
  result.addRoot(module('cockpit-standard', 'cockpit'));
  result.append(module('tank-3-main', 'tank-main'));
  if (withRcsTank) result.append(module('tank-3-rcs', 'tank-rcs'));
  return result;
}

function motion(assembly: ShipAssembly, temperature: number): ModularShipMotion {
  const attitude: Attitude = { q: Q_IDENTITY, w: v3(), inertia: v3(1, 1, 1) };
  return new ModularShipMotion(
    assembly, kinematicState<'eci'>(0, v3(), v3()), attitude, {}, { temperature },
  );
}

// 大気を持たない地球1体だけの顔ぶれ。stepSimulation が pivot の天体を引くために要る。
function earthOnlyBodies(): readonly CelestialBody[] {
  return [
    fixedMotion({
      id: 'earth', mu: MU_EARTH, radius: R_EARTH,
      state: kinematicState<'eci'>(0, v3(), v3()), accel: v3(), degree2: null, atmosphere: null,
    }),
  ];
}

// 高度 420km の円軌道へ乗せた motion。重力が働く状態で進行の歩を回すために使う。
function orbitingMotion(assembly: ShipAssembly, temperature: number): ModularShipMotion {
  const r0 = R_EARTH + 420e3;
  const attitude: Attitude = { q: Q_IDENTITY, w: v3(), inertia: v3(1, 1, 1) };
  return new ModularShipMotion(
    assembly,
    kinematicState<'eci'>(0, v3(r0, 0, 0), v3(0, Math.sqrt(MU_EARTH / r0), 0)),
    attitude, {}, { temperature },
  );
}

export function register(): void {
  test('consumeMainFuel: 消費した燃料に比例して外殻を冷やす', () => {
    const m = motion(ship(), 600);
    const consumed = m.consumeMainFuel(10);
    assert.equal(consumed, 10);
    // 1 単位あたり 0.05MJ を質量で割った比熱量だけ、次の熱の歩へ負の熱として積む。
    const expected = -consumed * JOULES_PER_UNIT / m.mass;
    assert.ok(Math.abs(m.thermal.pendingSpecificHeat - expected) < 1e-9);
  });

  test('consumeMainFuel: 燃料が足りないとき流れた分だけ冷やす', () => {
    const m = motion(ship(), 600);
    const consumed = m.consumeMainFuel(200);
    // タンクは 80 単位しか持たないので、流れた 80 単位ぶんだけ冷える。
    assert.equal(consumed, 80);
    const expected = -80 * JOULES_PER_UNIT / m.mass;
    assert.ok(Math.abs(m.thermal.pendingSpecificHeat - expected) < 1e-9);
  });

  test('consumeMainFuel: 冷却で温度を 0K 以下へ下げない', () => {
    const m = motion(ship(), 1);
    m.consumeMainFuel(80);
    // 除ける熱量は「温度を 0K へ下げるのに要する比熱量」が上限。
    assert.ok(Math.abs(m.thermal.pendingSpecificHeat - (-1 * m.specificHeat)) < 1e-9);
  });

  test('consumeMainFuel: RCS の消費は冷却しない', () => {
    const m = motion(ship(true), 600);
    m.assembly.consumeFuel('rcs', 5);
    assert.equal(m.thermal.pendingSpecificHeat, 0);
  });

  test('coolingDump: 流し中は流量ぶん燃料を消費して冷やし、推力は出ない', () => {
    const m = motion(ship(), 600);
    const dump = m.coolingDump;
    dump.toggle();
    assert.equal(dump.running, true);
    dump.update(1, units => m.consumeMainFuel(units));
    const expected = -DUMP_FLOW_RATE * JOULES_PER_UNIT / m.mass;
    assert.ok(Math.abs(m.thermal.pendingSpecificHeat - expected) < 1e-9);
    // 推力指令は冷却ダンプでは立たない。
    assert.equal(m.thrust, null);
    assert.equal(dump.running, true);
  });

  test('coolingDump: 燃料が尽きると自ら止まる', () => {
    const m = motion(ship(), 600);
    const dump = m.coolingDump;
    dump.toggle();
    m.assembly.consumeFuel('main', 1e9);
    dump.update(1, units => m.consumeMainFuel(units));
    assert.equal(dump.running, false);
  });

  test('coolingDump: 進行の歩から燃料を消費して外殻を冷やす', () => {
    const bodies = earthOnlyBodies();
    const m = orbitingMotion(ship(), 600);
    m.coolingDump.toggle();
    m.stepSimulation(1, bodies, occludersOf(bodies, bodies), null, null, 0, {} as DynamicReactionServices);
    // 1 秒ぶんの流量が主燃料から引かれ、温度は流す前より下がる。
    assert.ok(Math.abs(m.assembly.consumeFuel('main', 1e9) - (80 - DUMP_FLOW_RATE)) < 1e-6);
    assert.ok(m.temperature < 600);
  });

  test('coolingDump: 流し中かどうかを保存して復元する', () => {
    const dump = CoolingDump.deserialize(true);
    assert.equal(dump.running, true);
    dump.toggle();
    assert.equal(dump.serialize(), false);
  });
}
