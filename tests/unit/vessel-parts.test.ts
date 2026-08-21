// 搭載要素の一覧(§6-1)と、性能値の合成(§6-5)の回帰テスト。
// 既定の設計の合計値が const.ts の定数と一致することを固定する。
import * as assert from 'node:assert/strict';
import * as C from '../../src/game/const';
import type { AnyPart, PartType } from '../../src/game/game-entity/parts';
import { createPart, partFromSaveData } from '../../src/game/game-entity/parts';
import { PartInventory } from '../../src/game/vessel/part-inventory';
import { propellantTankCapacity } from '../../src/game/economy/propellant-compatibility';
import { baseParts, crewedParts, hostileParts, tuneActuators } from '../../src/game/vessel/vessel-parts';
import { crewedMassProperties } from '../../src/game/vessel/vessel-assemblies';
import { principalMoments } from '../../src/physics/inertia-tensor';
import { test } from '../physics/harness';

// §6-1 が挙げる搭載要素。外装11種・内装20種に、主要構造と装甲を加えたもの。
const REQUIRED_PART_TYPES: readonly PartType[] = [
  'hull', 'armor',
  'weapon', 'engine', 'rcs_thruster', 'solar_panel', 'radiator', 'combat_shield', 'heat_shield',
  'communication', 'robot_arm', 'docking_port', 'container_coupling',
  'oxidizer_tank', 'reductant_tank', 'pressurant_tank', 'rcs_tank', 'water_tank',
  'battery', 'fuel_cell', 'rtg', 'cockpit', 'autopilot', 'magazine', 'ammunition',
  'plumbing', 'payload_bay', 'flywheel', 'magnetorquer', 'base_module', 'farm', 'life_support', 'dock',
];

const CREWED_MAX_HP = C.PLAYER_MAX_HP;

// 質量特性に合わせて性能を整えた既定の有人艦。素の crewedParts は主機とフライホイールの性能を
// 持たず、形状から導いた質量と慣性を tuneActuators が与えて初めて決まる(§10-4)。
function crewedInventory(): PartInventory {
  const derived = crewedMassProperties();
  const parts = crewedParts(CREWED_MAX_HP);
  tuneActuators(parts, derived.loadedMass, principalMoments(derived.inertia).z);
  return new PartInventory(parts);
}

export function register(): void {
  test('§6-1 の搭載要素がすべて作れ、保存を往復しても型が保たれる', () => {
    for (const type of REQUIRED_PART_TYPES) {
      const part = createPart(type, { name: type } as never) as AnyPart;
      assert.equal(part.type, type);
      const restored = partFromSaveData(part);
      assert.equal(restored.type, type);
      assert.equal(restored.id, part.id);
    }
  });

  test('既定の有人艦の総推力が、導出した質量 × 最大スロットルと一致する', () => {
    const inv = crewedInventory();
    const maxThrottle = C.THROTTLE_LEVELS[C.THROTTLE_LEVELS.length - 1]!;
    assert.equal(inv.totalThrust, crewedMassProperties().loadedMass * maxThrottle);
    // 並進 RCS の推力は主機に数えない。
    assert.ok(inv.totalRcsThrust > 0);
  });

  test('既定の有人艦の総トルクが MAX_ANG_ACCEL × 最大主慣性モーメントと一致する', () => {
    // 手触りの保存: 慣性が形状由来の値になっても、出せる角加速度は MAX_ANG_ACCEL のままである。
    const maxMoment = principalMoments(crewedMassProperties().inertia).z;
    const inv = crewedInventory();
    assert.equal(inv.totalTorque, C.MAX_ANG_ACCEL * maxMoment);
    assert.ok(Math.abs(inv.totalTorque / maxMoment - C.MAX_ANG_ACCEL) < 1e-12);
  });

  test('既定の有人艦の推進剤容量・蓄電容量が const.ts の定数と一致する', () => {
    const inv = crewedInventory();
    // 主機と RCS が同じヒドラジンを共有するので、容量は RCS タンクと主タンクの合計になる。
    const expectedCapacity = propellantTankCapacity('hydrazine', C.CREWED_RCS_TANK_VOLUME) +
      propellantTankCapacity('hydrazine', C.CREWED_MAIN_TANK_VOLUME);
    assert.equal(inv.maxFuelOf('hydrazine'), expectedCapacity);
    assert.equal(inv.fuelOf('hydrazine'), expectedCapacity);
    assert.equal(inv.totalEnergyStorage, C.POWER_CAPACITY);
    assert.ok(inv.propellantVolume('hydrazine') > 0);
  });

  test('既定の有人艦の総発電・放熱能力がパドルと放熱板の面積から出る', () => {
    const inv = crewedInventory();
    assert.equal(inv.totalPowerGeneration, C.SOLAR_CONSTANT * C.SOLAR_PANEL_AREA * C.SOLAR_PANEL_EFFICIENCY);
    assert.equal(inv.totalCoolingRate, C.RADIATOR_COOLING_AREA * C.RADIATOR_EFFICIENCY_MULT);
  });

  test('既定の有人艦の消費電力と廃熱が const.ts の定数と一致する', () => {
    const inv = crewedInventory();
    assert.equal(inv.totalPowerDraw, C.CREWED_POWER_DRAW);
    assert.equal(inv.totalWasteHeat, C.CREWED_WASTE_HEAT);
    // 廃熱は消費電力を下回らない。
    assert.ok(inv.totalWasteHeat >= inv.totalPowerDraw);
  });

  test('廃熱の集計が消費電力を持つ要素をすべて拾う', () => {
    const draws: readonly (readonly [PartType, object])[] = [
      ['communication', { powerDraw: 11, range: 1 }],
      ['autopilot', { powerDraw: 13 }],
      ['flywheel', { powerDraw: 17 }],
      ['magnetorquer', { powerDraw: 19 }],
      ['farm', { powerDraw: 23 }],
      ['life_support', { powerDraw: 29 }],
      ['combat_shield', { powerDraw: 31, movable: true }],
    ];
    for (const [type, props] of draws) {
      const before = new PartInventory([createPart('hull', { name: 'Hull' })]).totalWasteHeat;
      const after = new PartInventory([
        createPart('hull', { name: 'Hull' }),
        createPart(type, { name: type, ...props } as never),
      ]).totalWasteHeat;
      assert.equal(after - before, Number((props as { powerDraw: number }).powerDraw), type);
    }
    // 全損した要素は電力を引かない。
    const dead = createPart('farm', { name: 'Farm', powerDraw: 100, extraWasteHeat: 40 });
    dead.hp = 0;
    assert.equal(new PartInventory([dead]).totalWasteHeat, 0);
  });

  test('農場と生命維持装置は消費電力とは別の廃熱を足す', () => {
    const inv = new PartInventory([
      createPart('farm', { name: 'Farm', powerDraw: 100, extraWasteHeat: 40 }),
    ]);
    assert.equal(inv.totalPowerDraw, 100);
    assert.equal(inv.totalWasteHeat, 140);
  });

  test('要素を1つ足すと対応する合計がその要素ぶんだけ増える', () => {
    const inv = crewedInventory();
    const thrust = inv.totalThrust;
    const torque = inv.totalTorque;
    const storage = inv.totalEnergyStorage;
    inv.replaceAll([
      ...inv.parts,
      createPart('engine', { name: 'Extra Engine', thrust: 1234 }),
      createPart('flywheel', { name: 'Extra Wheel', maxTorque: 56 }),
      createPart('battery', { name: 'Extra Battery', capacity: 7e5 }),
    ]);
    assert.equal(inv.totalThrust, thrust + 1234);
    assert.equal(inv.totalTorque, torque + 56);
    assert.equal(inv.totalEnergyStorage, storage + 7e5);
  });

  test('HP の配分が合計 maxHp と一致する', () => {
    for (const parts of [crewedParts(CREWED_MAX_HP), hostileParts(C.ENEMY_MAX_HP), baseParts(C.BASE_MAX_HP)]) {
      const inv = new PartInventory(parts);
      let sum = 0;
      for (const p of parts) sum += p.maxHp;
      assert.equal(inv.maxHp, sum);
      assert.equal(inv.hp, sum);
    }
    // 配分比は合計 1 なので、丸めの誤差ぶんしか機体の maxHp から離れない。
    const crewed = new PartInventory(crewedParts(CREWED_MAX_HP));
    assert.ok(Math.abs(crewed.maxHp - CREWED_MAX_HP) <= crewed.parts.length);
  });

  test('軌道基地の主機と姿勢トルクが基地の定数と一致する', () => {
    const inv = new PartInventory(baseParts(C.BASE_MAX_HP));
    assert.equal(inv.totalThrust, C.BASE_THRUST);
    assert.equal(inv.totalTorque, C.BASE_TORQUE);
    // RCS タンクと主タンクが同じヒドラジンを共有するので、容量は両者の合計になる。
    assert.equal(inv.maxFuelOf('hydrazine'),
      C.BASE_MAX_FUEL + propellantTankCapacity('hydrazine', C.BASE_MAIN_TANK_VOLUME));
  });
}
