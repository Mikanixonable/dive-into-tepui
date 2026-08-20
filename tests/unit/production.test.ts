// 設計から実機へ至る生産の経路(第3巻 B6)の回帰テスト。要求の集計・在庫の消費・生産時間、
// および建造費の表の網羅を固定する。
import * as assert from 'node:assert/strict';
import { PART_BUILD_MATERIALS, TANK_SHELL_FRACTION, catalystMassFor, partBuildCost } from '../../src/game/economy/build-cost';
import { RESOURCES } from '../../src/game/economy/resource';
import { createPart, type PartType } from '../../src/game/game-entity/parts';
import {
  partProductionBlueprintOf, refuelBlueprintOf, repairBlueprintOf,
} from '../../src/game/vessel/production';
import { test } from '../physics/harness';

// 殻の材料を推進剤が決める搭載要素。この3種だけは建造費の表が殻を持たない。
const SHELL_BY_PROPELLANT: readonly PartType[] = ['oxidizer_tank', 'reductant_tank', 'rcs_tank'];

export function register(): void {
  test('production: 建造費を持たない搭載要素が1つも無い', () => {
    for (const type of Object.keys(PART_BUILD_MATERIALS) as readonly PartType[]) {
      const materials = PART_BUILD_MATERIALS[type];
      assert.ok(materials.length > 0, `${type} の建造費が空`);
      for (const material of materials) {
        assert.ok(material.resourceId in RESOURCES, `${type} が未登録の資源 ${material.resourceId} を要求している`);
        assert.ok(material.fraction > 0, `${type} の内訳に 0 以下の割合がある`);
      }
      const total = materials.reduce((sum, m) => sum + m.fraction, 0);
      const expected = SHELL_BY_PROPELLANT.includes(type) ? 1 - TANK_SHELL_FRACTION : 1;
      assert.ok(Math.abs(total - expected) < 1e-9, `${type} の内訳の合計が ${expected} でない: ${total}`);
    }
  });

  test('production: 建造費は要素の質量に比例する', () => {
    const light = createPart('battery', { weight: 10 });
    const heavy = createPart('battery', { weight: 100 });
    const lightTotal = partBuildCost(light).reduce((sum, c) => sum + c.mass, 0);
    const heavyTotal = partBuildCost(heavy).reduce((sum, c) => sum + c.mass, 0);
    assert.ok(Math.abs(lightTotal - 10) < 1e-9);
    assert.ok(Math.abs(heavyTotal - 100) < 1e-9);
  });

  test('production: 触媒床の要求が推力に比例し、二液推進剤では 0 になる', () => {
    // 特許の実測点(推力 22 N で 24 g)を再現する。
    assert.ok(Math.abs(catalystMassFor(22) - 0.024) < 5e-4);
    // 25 N の境界で2式が連続する。
    assert.ok(Math.abs(catalystMassFor(25) - catalystMassFor(25.0001)) < 1e-6);
    // 既定の有人艦の RCS スラスタ(5,000 N)は触媒床 385 g を要求する。
    assert.ok(Math.abs(catalystMassFor(5000) - 0.385) < 5e-3);

    const mono = createPart('rcs_thruster', { weight: 8, propellant: 'hydrazine', thrust: 22, catalystMass: catalystMassFor(22) });
    const catalyst = partBuildCost(mono).find((c) => c.resourceId === 'catalyst-bed');
    assert.ok(catalyst !== undefined && catalyst.mass > 0);

    // 二液推進剤は自己着火性であり触媒を要さない。
    const bipropellant = createPart('engine', { weight: 80, propellant: 'nitrogen-tetroxide', thrust: 5000 });
    assert.equal(partBuildCost(bipropellant).find((c) => c.resourceId === 'catalyst-bed'), undefined);
  });

  test('production: 搭載要素を1つだけ作る要求は、その要素の建造費そのものになる', () => {
    const engine = createPart('engine', { weight: 80, propellant: 'nitrogen-tetroxide', thrust: 5000 });
    const request = partProductionBlueprintOf(engine);
    assert.equal(request.parts.length, 1);
    assert.deepEqual(request.parts[0]!.buildCost, partBuildCost(engine));
    // 推進剤を積まない要素はタンクの枠を持たない。
    assert.deepEqual(request.tanks, []);
    // 推進剤タンクは殻を tanks の枠へ回す。
    const tank = createPart('rcs_tank', { weight: 30, propellant: 'hydrazine' });
    const tankRequest = partProductionBlueprintOf(tank);
    assert.equal(tankRequest.tanks.length, 1);
    assert.ok(Math.abs(tankRequest.tanks[0]!.shellMass - 30 * TANK_SHELL_FRACTION) < 1e-9);
  });

  test('production: 修理は失われた耐久の割合ぶんの資材を要し、無傷なら 0 になる', () => {
    const intact = createPart('battery', { weight: 100, maxHp: 100, hp: 100 });
    const total = (bp: ReturnType<typeof repairBlueprintOf>): number =>
      bp.parts[0]!.buildCost.reduce((sum, c) => sum + c.mass, 0);
    assert.equal(total(repairBlueprintOf(intact)), 0);

    const half = createPart('battery', { weight: 100, maxHp: 100, hp: 50 });
    assert.ok(Math.abs(total(repairBlueprintOf(half)) - 50) < 1e-9);

    // 殻は残っているので、タンクを直しても殻は課金しない。
    const tank = createPart('rcs_tank', { weight: 30, propellant: 'hydrazine', maxHp: 100, hp: 0 });
    assert.deepEqual(repairBlueprintOf(tank).tanks, []);
  });

  test('production: 補給は積んでいる推進剤そのものを質量ぶん引く', () => {
    const request = refuelBlueprintOf('hydrazine', 250);
    assert.deepEqual(request.parts[0]!.buildCost, [{ resourceId: 'hydrazine', mass: 250 }]);
    // 液体酸素は在庫の上では酸素である。
    assert.deepEqual(refuelBlueprintOf('liquid-oxygen', 10).parts[0]!.buildCost,
      [{ resourceId: 'oxygen', mass: 10 }]);
    // 補給は設備を要さない。
    assert.deepEqual(request.requiresFacility, []);
  });
}
