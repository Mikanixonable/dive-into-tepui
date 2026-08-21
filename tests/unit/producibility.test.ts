// 生産可能性の判定(§17-11)と材料適合性(§17-2)の回帰テスト。
import * as assert from 'node:assert/strict';
import {
  BlueprintPart,
  ProducibilityBlueprint,
  Requirement,
  producibility,
} from '../../src/game/economy/producibility';
import { FACILITIES } from '../../src/game/economy/facility';
import { ResourceLedger } from '../../src/game/economy/resource-ledger';
import { test } from '../physics/harness';

// 建造費だけを持つ最小の搭載要素。
function part(partId: string, count: number, mass: number): BlueprintPart {
  return { partId, count, buildCost: [{ resourceId: 'machinery', mass }], requiresFacility: [] };
}

// 資源を要さず、組立ドックだけを要求する搭載要素。
function dockPart(partId: string): BlueprintPart {
  return { partId, count: 1, buildCost: [], requiresFacility: ['assembly-dock'] };
}

// 何も要求しない設計を土台に、必要な部分だけを差し替える。
function blueprint(over: Partial<ProducibilityBlueprint> = {}): ProducibilityBlueprint {
  return { parts: [], tanks: [], structure: [], requiresFacility: [], ...over };
}

function ledgerOf(entries: readonly (readonly [string, number])[]): ResourceLedger {
  const ledger = new ResourceLedger();
  for (const [id, mass] of entries) ledger.add(id as never, mass);
  return ledger;
}

function idsOf(reqs: readonly Requirement[], kind: Requirement['kind']): readonly string[] {
  return reqs.filter((r) => r.kind === kind).map((r) => r.id);
}

export function register(): void {
  test('producibility: すべて足りているとき空配列を返す', () => {
    const bp = blueprint({
      parts: [part('engine', 2, 100)],
      structure: [{ resourceId: 'hull-panel', mass: 500 }],
      tanks: [{ propellantId: 'hydrazine', shellMass: 50 }],
      requiresFacility: ['assembly-dock'],
    });
    const ledger = ledgerOf([
      ['machinery', 200],
      ['hull-panel', 500],
      ['structural-metal', 50],
    ]);
    assert.deepEqual(producibility(bp, ledger, ['assembly-dock'], 1e9), []);
  });

  test('producibility: 不足した資源が実際の needed と available で列挙される', () => {
    const bp = blueprint({
      parts: [part('engine', 3, 100)],
      structure: [{ resourceId: 'hull-panel', mass: 500 }],
    });
    const ledger = ledgerOf([
      ['machinery', 120],
      ['hull-panel', 500],
    ]);
    const reqs = producibility(bp, ledger, [], 1e9);
    assert.equal(reqs.length, 1);
    // 3基ぶんの建造費が積み上がり、真偽値ではなく実際の値が載る。
    assert.deepEqual(reqs[0], { kind: 'resource', id: 'machinery', needed: 300, available: 120 });
  });

  test('producibility: 要求の種別は資源・設備・電力の3つに限られる', () => {
    const bp = blueprint({
      parts: [part('engine', 1, 100)],
      tanks: [{ propellantId: 'hydrazine', shellMass: 20 }],
      requiresFacility: ['assembly-dock'],
    });
    const reqs = producibility(bp, new ResourceLedger(), [], 0);
    assert.ok(reqs.length > 0);
    for (const r of reqs) {
      assert.ok(['resource', 'facility', 'power'].includes(r.kind), `未知の種別: ${r.kind}`);
    }
  });

  test('producibility: 資源・設備・電力が同時に足りないとき3種すべてが挙がる', () => {
    const bp = blueprint({
      parts: [part('engine', 1, 100)],
      requiresFacility: ['assembly-dock'],
    });
    const reqs = producibility(bp, new ResourceLedger(), [], 0);
    const kinds = new Set(reqs.map((r) => r.kind));
    assert.deepEqual([...kinds].sort(), ['facility', 'power', 'resource']);
  });

  test('producibility: 電力だけが不足しているとき power の要求が1件だけ返る', () => {
    const bp = blueprint({ requiresFacility: ['assembly-dock'] });
    const draw = FACILITIES['assembly-dock'].powerDraw;
    const reqs = producibility(bp, new ResourceLedger(), ['assembly-dock'], draw - 1);
    assert.deepEqual(reqs, [{ kind: 'power', id: 'power', needed: draw, available: draw - 1 }]);
  });

  test('producibility: 同じ設備を2つの搭載要素が要求しても電力は1基ぶん', () => {
    // 設備の実物は1基なので、要求が何件あっても同時に動く台数は増えない。
    const draw = FACILITIES['assembly-dock'].powerDraw;
    const twice = blueprint({ parts: [dockPart('engine'), dockPart('tank')] });
    assert.deepEqual(producibility(twice, new ResourceLedger(), ['assembly-dock'], draw), []);

    const once = blueprint({ parts: [dockPart('engine')] });
    assert.deepEqual(
      producibility(twice, new ResourceLedger(), ['assembly-dock'], draw - 1),
      producibility(once, new ResourceLedger(), ['assembly-dock'], draw - 1),
      '要求の件数は消費電力を変えない',
    );
  });

  test('producibility: 同じ設備を持っていないときも設備要求は1件にまとまる', () => {
    const twice = blueprint({ requiresFacility: ['assembly-dock'], parts: [dockPart('engine')] });
    const reqs = producibility(twice, new ResourceLedger(), [], 1e9);
    assert.deepEqual(idsOf(reqs, 'facility'), ['assembly-dock']);
  });

  test('producibility: ヒドラジンのタンクは殻の金属だけを要求する', () => {
    // 触媒床の白金族はスラスタの建造費が持つので、タンクの側は殻の材料だけを問う。
    const bp = blueprint({ tanks: [{ propellantId: 'hydrazine', shellMass: 10 }] });
    assert.deepEqual(producibility(bp, ledgerOf([['structural-metal', 10]]), [], 1e9), []);
  });

  test('producibility: 殻の材料が足りなければヒドラジンのタンクは拒否される', () => {
    const bp = blueprint({ tanks: [{ propellantId: 'hydrazine', shellMass: 40 }] });
    const empty = new ResourceLedger();
    const reqs = producibility(bp, empty, [], 1e9);
    assert.deepEqual(reqs, [{ kind: 'resource', id: 'structural-metal', needed: 40, available: 0 }]);
  });

  test('producibility: 判定は在庫を消費しない', () => {
    const bp = blueprint({
      parts: [part('engine', 1, 100)],
      tanks: [{ propellantId: 'hydrazine', shellMass: 50 }],
      requiresFacility: ['assembly-dock'],
    });
    const ledger = ledgerOf([
      ['machinery', 100],
      ['structural-metal', 50],
    ]);
    producibility(bp, ledger, [], 0);
    assert.equal(ledger.amountOf('machinery'), 100);
    assert.equal(ledger.amountOf('structural-metal'), 50);
  });
}
