// game/economy の資源・産地・設備データの整合と、ResourceLedger の在庫増減の回帰テスト。
import * as assert from 'node:assert/strict';
import { SOLAR_SYSTEM } from '../../src/physics/solar-system';
import { ACTUATOR_MATERIALS } from '../../src/game/economy/actuator-materials';
import { DEPOSITS, ENEMY_DROPS } from '../../src/game/economy/deposit';
import { FACILITIES, FACILITY_IDS, FacilityId, INITIAL_FACILITY_IDS } from '../../src/game/economy/facility';
import { PROPELLANT_IDS, TANK_MATERIALS } from '../../src/game/economy/propellant-compatibility';
import { RESOURCES, RESOURCE_IDS, ResourceId } from '../../src/game/economy/resource';
import { ResourceLedger } from '../../src/game/economy/resource-ledger';
import { test } from '../physics/harness';

function knownResource(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(RESOURCES, id);
}

export function register(): void {
  test('economy: RESOURCES のキーと id が一致し、密度が有限の正値である', () => {
    for (const id of RESOURCE_IDS) {
      const def = RESOURCES[id];
      assert.equal(def.id, id, `資源 ${id} の id がキーと違う`);
      assert.ok(def.name.length > 0, `資源 ${id} に表示名が無い`);
      assert.ok(def.symbol.length > 0, `資源 ${id} に記号が無い`);
      assert.ok(Number.isFinite(def.density) && def.density > 0, `資源 ${id} の密度が不正`);
    }
  });

  test('economy: FACILITIES の入出力・建設費がすべて登録済みの資源を指す', () => {
    for (const id of FACILITY_IDS) {
      const f = FACILITIES[id];
      assert.equal(f.id, id, `設備 ${id} の id がキーと違う`);
      for (const i of f.inputs) {
        assert.ok(i.anyOf.length > 0, `設備 ${id} に選択肢の無い入力枠がある`);
        for (const candidate of i.anyOf) {
          assert.ok(knownResource(candidate), `設備 ${id} の入力に未登録の資源: ${candidate}`);
        }
        assert.ok(Number.isFinite(i.rate) && i.rate > 0, `設備 ${id} の入力速度が不正: ${i.anyOf.join('|')}`);
      }
      for (const o of f.outputs) {
        assert.ok(knownResource(o.resourceId), `設備 ${id} の出力に未登録の資源: ${o.resourceId}`);
        assert.ok(Number.isFinite(o.rate) && o.rate > 0, `設備 ${id} の出力速度が不正: ${o.resourceId}`);
      }
      for (const c of f.buildCost) {
        assert.ok(knownResource(c.resourceId), `設備 ${id} の建設費に未登録の資源: ${c.resourceId}`);
        assert.ok(Number.isFinite(c.mass) && c.mass > 0, `設備 ${id} の建設費が不正: ${c.resourceId}`);
      }
      assert.ok(Number.isFinite(f.powerDraw) && f.powerDraw >= 0, `設備 ${id} の消費電力が不正`);
      assert.ok(Number.isFinite(f.powerOutput) && f.powerOutput >= 0, `設備 ${id} の発電量が不正`);
      assert.ok(f.buildCost.length > 0, `設備 ${id} に建設費が無い`);
    }
  });

  test('economy: 発電設備だけが powerOutput を持ち、資源は出さない', () => {
    const generators = FACILITY_IDS.filter((id) => FACILITIES[id].powerOutput > 0);
    assert.deepEqual([...generators].sort(), ['fission-reactor', 'solar-array']);
    for (const id of generators) {
      // 電力は資源ではないため、発電設備の outputs は空になる。
      assert.deepEqual(FACILITIES[id].outputs, [], `発電設備 ${id} が資源を出している`);
    }
    for (const id of FACILITY_IDS) {
      if (generators.includes(id)) continue;
      assert.equal(FACILITIES[id].powerOutput, 0, `発電設備でない ${id} が発電している`);
    }
  });

  test('economy: 送電網は発電も消費もしない', () => {
    const grid = FACILITIES['power-grid'];
    assert.equal(grid.powerDraw, 0);
    assert.equal(grid.powerOutput, 0);
    assert.deepEqual(grid.outputs, []);
  });

  test('economy: 同じ役を果たす資源は anyOf に並ぶ', () => {
    const anyOfOf = (id: FacilityId, index: number): readonly string[] => FACILITIES[id].inputs[index].anyOf;
    assert.deepEqual(anyOfOf('fission-reactor', 0), ['uranium', 'thorium']);
    assert.deepEqual(anyOfOf('electronics-factory', 1), ['copper', 'aluminium']);
    assert.deepEqual(anyOfOf('winding-factory', 0), ['aluminium', 'copper']);
    assert.deepEqual(anyOfOf('nuclear-fuel-refinery', 0), ['kreep-rock', 'm-type-ore']);
  });

  test('economy: requiresFacility が登録済みの設備を指し、自己参照しない', () => {
    for (const id of FACILITY_IDS) {
      for (const required of FACILITIES[id].requiresFacility) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(FACILITIES, required),
          `設備 ${id} の前提に未登録の設備: ${required}`,
        );
        assert.notEqual(required, id, `設備 ${id} が自分自身を前提にしている`);
      }
    }
  });

  test('economy: 設備の前提関係に循環が無い', () => {
    // 前提をたどる深さ優先探索で、探索中の設備へ戻る辺があれば循環している。
    const visiting = new Set<string>();
    const done = new Set<string>();
    const walk = (id: string): void => {
      if (done.has(id)) return;
      assert.ok(!visiting.has(id), `設備の前提が循環している: ${id}`);
      visiting.add(id);
      for (const required of FACILITIES[id as keyof typeof FACILITIES].requiresFacility) walk(required);
      visiting.delete(id);
      done.add(id);
    };
    for (const id of FACILITY_IDS) walk(id);
  });

  test('economy: 最初から持っている設備が10基で、金属の板と殻と骨組みまでを賄う', () => {
    assert.deepEqual([...INITIAL_FACILITY_IDS].sort(), [
      'apatite-miner',
      'assembly-dock',
      'ice-miner',
      'molten-salt-electrolysis',
      'molten-salt-preparation',
      'power-grid',
      'regolith-miner',
      'rolling-mill',
      'smelter',
      'solar-array',
    ]);
    // 溶融塩電解炉はレゴリスを要するため、レゴリス採掘機も最初の一組に含まれる。
    assert.equal(INITIAL_FACILITY_IDS.length, 10);
    // エンジンも通信モジュールも磁気トルカも、この一組では作れない。
    for (const id of ['machine-shop', 'electronics-factory', 'winding-factory'] as const) {
      assert.ok(!INITIAL_FACILITY_IDS.includes(id), `${id} は最初から持っている設備ではない`);
    }
  });

  test('economy: DEPOSITS が登録済みの天体と資源を指す', () => {
    for (const d of DEPOSITS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(SOLAR_SYSTEM, d.bodyId),
        `産地に未登録の天体: ${d.bodyId}`,
      );
      assert.ok(knownResource(d.resourceId), `産地 ${d.bodyId} に未登録の資源: ${d.resourceId}`);
      assert.ok(Number.isFinite(d.abundance) && d.abundance > 0, `産地 ${d.bodyId}/${d.resourceId} の係数が不正`);
    }
  });

  test('economy: 月の産地が溶融塩電解の出発点を揃えている', () => {
    const lunar = DEPOSITS.filter((d) => d.bodyId === 'moon').map((d) => d.resourceId);
    // 塩が無ければ金属は取り出せないため、アパタイトはレゴリスと同じく月で採れる。
    assert.ok(lunar.includes('regolith'));
    assert.ok(lunar.includes('apatite'));
    assert.ok(lunar.includes('water'));
    // 月には炭素と窒素が事実上無い。
    assert.ok(!lunar.includes('carbon'));
    assert.ok(!lunar.includes('nitrogen'));
  });

  test('economy: 敵のドロップが炭素・窒素・白金族・希土類を含む', () => {
    for (const drop of ENEMY_DROPS) {
      for (const d of drop.drops) {
        assert.ok(knownResource(d.resourceId), `敵 ${drop.enemyKind} のドロップに未登録の資源: ${d.resourceId}`);
        const [lo, hi] = d.massRange;
        assert.ok(lo > 0 && hi >= lo, `敵 ${drop.enemyKind} のドロップ質量域が不正: ${d.resourceId}`);
      }
    }
    const drifting = ENEMY_DROPS.find((d) => d.enemyKind === 'drifting');
    assert.ok(drifting !== undefined);
    const ids = drifting.drops.map((d) => d.resourceId);
    for (const id of ['carbon', 'nitrogen', 'sulfur', 'copper', 'platinum-group', 'rare-earth'] as const) {
      assert.ok(ids.includes(id), `敵のドロップに ${id} が無い`);
    }
  });

  test('economy: 材料適合性が §17-2 の推進剤をすべて持ち、資源を指す', () => {
    assert.deepEqual([...PROPELLANT_IDS].sort(), [
      'hydrazine',
      'hydrogen-peroxide',
      'liquid-hydrogen',
      'liquid-methane',
      'liquid-oxygen',
      'nitrogen-tetroxide',
      'silane',
    ]);
    for (const id of PROPELLANT_IDS) {
      const req = TANK_MATERIALS[id];
      assert.equal(req.propellantId, id);
      assert.ok(req.allowedMaterials.length > 0, `推進剤 ${id} に使える材料が無い`);
      for (const m of [...req.allowedMaterials, ...req.requiredResources]) {
        assert.ok(knownResource(m), `推進剤 ${id} が未登録の資源を要求している: ${m}`);
      }
    }
  });

  test('economy: 四酸化二窒素はアルミだけを許し、ヒドラジンは触媒床の要求をタンクへ紐付けない', () => {
    // チタンとは応力腐食割れを起こす。
    assert.deepEqual(TANK_MATERIALS['nitrogen-tetroxide'].allowedMaterials, ['aluminium']);
    const hydrogenTank: readonly string[] = TANK_MATERIALS['liquid-hydrogen'].allowedMaterials;
    assert.ok(!hydrogenTank.includes('titanium'), '水素脆化によりチタンは使えない');
    // 触媒床の質量は推力に比例するので、要求はタンクではなくスラスタの建造費が持つ(§6-4)。
    assert.deepEqual(TANK_MATERIALS.hydrazine.requiredResources, []);
    // 制約の緩い組は3金属すべてを許す。
    assert.equal(TANK_MATERIALS['liquid-oxygen'].allowedMaterials.length, 3);
  });

  test('economy: 磁気トルカは希土類を要さず、フライホイールは要する', () => {
    const torquer = ACTUATOR_MATERIALS.magnetorquer;
    const flywheel = ACTUATOR_MATERIALS.flywheel;
    const torquerNeeds: readonly string[] = torquer.requiredResources;
    assert.ok(!torquerNeeds.includes('rare-earth'));
    assert.ok(torquerNeeds.includes('iron'));
    assert.deepEqual(torquer.alternativeResources, [['aluminium', 'copper']]);
    const flywheelNeeds: readonly string[] = flywheel.requiredResources;
    assert.ok(flywheelNeeds.includes('rare-earth'));
    for (const req of [torquer, flywheel]) {
      for (const id of [...req.requiredResources, ...req.alternativeResources.flat()]) {
        assert.ok(knownResource(id), `アクチュエータ ${req.actuatorId} が未登録の資源を要求している: ${id}`);
      }
    }
  });

  test('ResourceLedger: 未登録の在庫は 0、加算で積み上がる', () => {
    const ledger = new ResourceLedger();
    assert.equal(ledger.amountOf('iron'), 0);
    ledger.add('iron', 100);
    ledger.add('iron', 50);
    assert.equal(ledger.amountOf('iron'), 150);
    assert.equal(ledger.amountOf('aluminium'), 0);
    assert.deepEqual(ledger.storedIds, ['iron']);
  });

  test('ResourceLedger: 足りるときだけ取り出せ、在庫は 0 未満にならない', () => {
    const ledger = new ResourceLedger();
    ledger.add('aluminium', 100);
    assert.equal(ledger.take('aluminium', 150), false);
    assert.equal(ledger.amountOf('aluminium'), 100, '不足時は在庫を減らさない');
    assert.equal(ledger.take('aluminium', 40), true);
    assert.equal(ledger.amountOf('aluminium'), 60);
    assert.equal(ledger.take('aluminium', 60), true);
    assert.equal(ledger.amountOf('aluminium'), 0);
    assert.equal(ledger.take('aluminium', 1), false);
    assert.equal(ledger.take('titanium', 1), false, '一度も入れていない資源は取り出せない');
  });

  test('ResourceLedger: 不正な質量は例外、0 は無害', () => {
    const ledger = new ResourceLedger();
    assert.throws(() => ledger.add('iron', -1));
    assert.throws(() => ledger.add('iron', Number.NaN));
    assert.throws(() => ledger.take('iron', -1));
    ledger.add('iron', 0);
    assert.equal(ledger.amountOf('iron'), 0);
    assert.equal(ledger.take('iron', 0), true, '0 の取り出しは常に成功する');
    ledger.add('iron', 10);
    ledger.clear();
    assert.equal(ledger.amountOf('iron'), 0);
  });

  test('ResourceLedger: すべての資源 id を扱える', () => {
    const ledger = new ResourceLedger();
    for (const id of RESOURCE_IDS) ledger.add(id as ResourceId, 1);
    assert.equal(ledger.storedIds.length, RESOURCE_IDS.length);
  });
}
