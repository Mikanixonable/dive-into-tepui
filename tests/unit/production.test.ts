// 設計から実機へ至る生産の経路(第3巻 B6)の回帰テスト。要求の集計・在庫の消費・生産時間、
// および建造費の表の網羅を固定する。
import * as assert from 'node:assert/strict';
import { PART_BUILD_MATERIALS, TANK_SHELL_FRACTION, catalystMassFor, partBuildCost } from '../../src/game/economy/build-cost';
import { producibility } from '../../src/game/economy/producibility';
import { ResourceLedger } from '../../src/game/economy/resource-ledger';
import type { ResourceId } from '../../src/game/economy/resource';
import { RESOURCES } from '../../src/game/economy/resource';
import { createPart, type PartType } from '../../src/game/game-entity/parts';
import { crewedShipBlueprint } from '../../src/game/vessel/default-blueprints';
import {
  ASSEMBLY_FACILITY, DEFAULT_PRODUCTION_TIME_FACTOR, consumeProductionResources,
  memberProductionBlueprintOf, partProductionBlueprintOf, productionBlueprintOf,
  productionResourceDemand, productionTimeOf, refuelBlueprintOf, repairBlueprintOf,
} from '../../src/game/vessel/production';
import { structuralMasses } from '../../src/game/vessel/mass-properties';
import { assemblyOf } from '../../src/game/vessel/blueprint';
import { MEMBER_DEFAULT_RADIUS, MEMBER_DEFAULT_SEPARATION_IMPULSE, type MemberSpec } from '../../src/game/vessel/member';
import { test } from '../physics/harness';

// 殻の材料を推進剤が決める搭載要素。この3種だけは建造費の表が殻を持たない。
const SHELL_BY_PROPELLANT: readonly PartType[] = ['oxidizer_tank', 'reductant_tank', 'rcs_tank'];

// 要求どおりの在庫を積んだ帳簿。
function ledgerFor(demand: ReadonlyMap<ResourceId, number>, scale = 1): ResourceLedger {
  const ledger = new ResourceLedger();
  for (const [id, mass] of demand) ledger.add(id, mass * scale);
  return ledger;
}

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

  test('production: 要求の集計が搭載要素と外皮の構造材の和になる', () => {
    const bp = crewedShipBlueprint(0);
    const request = productionBlueprintOf(bp);
    assert.equal(request.parts.length, bp.placements.length);
    assert.deepEqual(request.requiresFacility, [ASSEMBLY_FACILITY]);

    // 構造材は形状ツリーから導いた外皮とトラスの質量そのものである。
    const structural = structuralMasses(assemblyOf(bp));
    const hull = request.structure.find((s) => s.resourceId === 'hull-panel');
    assert.ok(hull !== undefined && Math.abs(hull.mass - structural.hull) < 1e-9);

    // 搭載要素の側は、1つずつの建造費の和になる。
    const demand = productionResourceDemand(request, new ResourceLedger());
    let partsTotal = 0;
    for (const part of request.parts) for (const cost of part.buildCost) partsTotal += cost.mass * part.count;
    let structureTotal = 0;
    for (const item of request.structure) structureTotal += item.mass;
    let tankTotal = 0;
    for (const tank of request.tanks) tankTotal += tank.shellMass;
    let demandTotal = 0;
    for (const mass of demand.values()) demandTotal += mass;
    assert.ok(Math.abs(demandTotal - (partsTotal + structureTotal + tankTotal)) < 1e-6);
  });

  test('production: 推進剤タンクの殻は推進剤が許す金属で課金される', () => {
    const request = productionBlueprintOf(crewedShipBlueprint(0));
    assert.ok(request.tanks.length > 0, '既定の有人艦は RCS 推進剤タンクを積む');
    for (const tank of request.tanks) assert.ok(tank.shellMass > 0);
    // ヒドラジンはアルミを許す。アルミだけの在庫でも殻は賄える。
    const demand = productionResourceDemand(request, new ResourceLedger());
    assert.ok((demand.get('aluminium') ?? 0) > 0);
  });

  test('production: 資源が足りなければ生産は拒否され、足せば通る', () => {
    const bp = crewedShipBlueprint(0);
    const request = productionBlueprintOf(bp);
    const facilities = [ASSEMBLY_FACILITY] as const;

    const empty = new ResourceLedger();
    const missing = producibility(request, empty, facilities, 1e9);
    assert.ok(missing.length > 0, '空の在庫では生産できない');
    assert.ok(missing.every((r) => r.kind === 'resource'), '設備と電力は足りている');

    const demand = productionResourceDemand(request, empty);
    // 1種だけ 1 割不足させると、その資源だけが不足として挙がる。
    const short = ledgerFor(demand);
    short.take('hull-panel', demand.get('hull-panel')! * 0.1);
    const shortReqs = producibility(request, short, facilities, 1e9);
    assert.deepEqual(shortReqs.map((r) => r.id), ['hull-panel']);

    // ちょうど足りる在庫にすると空配列になる。
    assert.deepEqual(producibility(request, ledgerFor(demand), facilities, 1e9), []);
  });

  test('production: 組立ドックが無ければ設備の不足として挙がる', () => {
    const request = productionBlueprintOf(crewedShipBlueprint(0));
    const reqs = producibility(request, ledgerFor(productionResourceDemand(request, new ResourceLedger())), [], 1e9);
    assert.ok(reqs.some((r) => r.kind === 'facility' && r.id === ASSEMBLY_FACILITY));
  });

  test('production: 在庫が要求どおり減り、足りなければ何も減らない', () => {
    const request = productionBlueprintOf(crewedShipBlueprint(0));
    const demand = productionResourceDemand(request, new ResourceLedger());

    // ちょうど2機ぶんの在庫から1機作ると、ちょうど1機ぶんが残る。
    const ledger = ledgerFor(demand, 2);
    assert.ok(consumeProductionResources(request, ledger));
    for (const [id, mass] of demand) assert.ok(Math.abs(ledger.amountOf(id) - mass) < 1e-6, `${id} の残量が合わない`);

    // 残り1機ぶんから2機目は作れるが、3機目は作れず、在庫は一切減らない。
    assert.ok(consumeProductionResources(request, ledger));
    const before = [...demand.keys()].map((id) => ledger.amountOf(id));
    assert.equal(consumeProductionResources(request, ledger), false);
    assert.deepEqual([...demand.keys()].map((id) => ledger.amountOf(id)), before);
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

  test('production: 生産時間係数 0 で即時完成する', () => {
    const bp = crewedShipBlueprint(0);
    assert.equal(DEFAULT_PRODUCTION_TIME_FACTOR, 0);
    assert.equal(productionTimeOf(bp, DEFAULT_PRODUCTION_TIME_FACTOR), 0);
    // 係数を上げれば搭載要素の合計質量に比例した時間になる。
    const mass = bp.placements.reduce((sum, p) => sum + p.part.weight, 0);
    assert.ok(Math.abs(productionTimeOf(bp, 2) - mass * 2) < 1e-9);
  });

  test('production: 部材1本の建造費は、その形状ぶんの構造材質量に一致する', () => {
    const hull: MemberSpec = { kind: 'hull', length: 4, radius: MEMBER_DEFAULT_RADIUS, separationImpulse: 0 };
    const request = memberProductionBlueprintOf(hull);
    assert.deepEqual(request.requiresFacility, [ASSEMBLY_FACILITY]);
    assert.equal(request.parts.length, 0);
    assert.equal(request.tanks.length, 0);
    const hullCost = request.structure.find((item) => item.resourceId === 'hull-panel')?.mass ?? 0;
    assert.ok(hullCost > 0);

    // トラス・分離機構は同じ資源(truss-member)へ合算される。
    const truss: MemberSpec = { kind: 'truss', length: 4, radius: MEMBER_DEFAULT_RADIUS, separationImpulse: 0 };
    const decoupler: MemberSpec = {
      kind: 'decoupler', length: 4, radius: MEMBER_DEFAULT_RADIUS, separationImpulse: MEMBER_DEFAULT_SEPARATION_IMPULSE,
    };
    for (const member of [truss, decoupler]) {
      const req = memberProductionBlueprintOf(member);
      assert.equal(req.structure.find((item) => item.resourceId === 'hull-panel'), undefined);
      assert.ok((req.structure.find((item) => item.resourceId === 'truss-member')?.mass ?? 0) > 0);
    }

    // 長くすれば質量も費用も増える。
    const longerHull: MemberSpec = { ...hull, length: 8 };
    const longerCost = memberProductionBlueprintOf(longerHull).structure
      .find((item) => item.resourceId === 'hull-panel')?.mass ?? 0;
    assert.ok(longerCost > hullCost);
  });

  test('production: 部材の建造費は在庫を消費し、足りなければ何も減らさず拒否する', () => {
    const hull: MemberSpec = { kind: 'hull', length: 4, radius: MEMBER_DEFAULT_RADIUS, separationImpulse: 0 };
    const request = memberProductionBlueprintOf(hull);
    const cost = request.structure.find((item) => item.resourceId === 'hull-panel')!.mass;

    const short = new ResourceLedger();
    short.add('hull-panel', cost - 1);
    assert.equal(consumeProductionResources(request, short), false);
    assert.equal(short.amountOf('hull-panel'), cost - 1);

    const enough = new ResourceLedger();
    enough.add('hull-panel', cost);
    assert.equal(consumeProductionResources(request, enough), true);
    assert.equal(enough.amountOf('hull-panel'), 0);
  });
}
