// game/economy の資源・設備データの整合と、ResourceLedger の在庫増減の回帰テスト。
import * as assert from 'node:assert/strict';
import { FACILITIES, FACILITY_IDS, INITIAL_FACILITY_IDS } from '../../src/game/economy/facility';
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

  test('economy: FACILITIES は組立ドックと太陽電池アレイの2基だけを持つ', () => {
    assert.deepEqual([...FACILITY_IDS].sort(), ['assembly-dock', 'solar-array']);
    assert.deepEqual([...INITIAL_FACILITY_IDS].sort(), ['assembly-dock', 'solar-array']);
  });

  test('economy: 太陽電池アレイだけが発電し、組立ドックは発電しない', () => {
    assert.ok(FACILITIES['solar-array'].powerOutput > 0);
    assert.equal(FACILITIES['assembly-dock'].powerOutput, 0);
    assert.ok(FACILITIES['assembly-dock'].powerDraw > 0);
  });

  test('economy: 材料適合性はヒドラジンだけを持ち、資源を指す', () => {
    assert.deepEqual([...PROPELLANT_IDS], ['hydrazine']);
    const req = TANK_MATERIALS.hydrazine;
    assert.equal(req.propellantId, 'hydrazine');
    assert.ok(req.allowedMaterials.length > 0, 'ヒドラジンに使える材料が無い');
    for (const m of [...req.allowedMaterials, ...req.requiredResources]) {
      assert.ok(knownResource(m), `ヒドラジンが未登録の資源を要求している: ${m}`);
    }
  });

  test('ResourceLedger: 未登録の在庫は 0、加算で積み上がる', () => {
    const ledger = new ResourceLedger();
    assert.equal(ledger.amountOf('titanium'), 0);
    ledger.add('titanium', 100);
    ledger.add('titanium', 50);
    assert.equal(ledger.amountOf('titanium'), 150);
    assert.equal(ledger.amountOf('structural-metal'), 0);
    assert.deepEqual(ledger.storedIds, ['titanium']);
  });

  test('ResourceLedger: 足りるときだけ取り出せ、在庫は 0 未満にならない', () => {
    const ledger = new ResourceLedger();
    ledger.add('structural-metal', 100);
    assert.equal(ledger.take('structural-metal', 150), false);
    assert.equal(ledger.amountOf('structural-metal'), 100, '不足時は在庫を減らさない');
    assert.equal(ledger.take('structural-metal', 40), true);
    assert.equal(ledger.amountOf('structural-metal'), 60);
    assert.equal(ledger.take('structural-metal', 60), true);
    assert.equal(ledger.amountOf('structural-metal'), 0);
    assert.equal(ledger.take('structural-metal', 1), false);
    assert.equal(ledger.take('titanium', 1), false, '一度も入れていない資源は取り出せない');
  });

  test('ResourceLedger: 不正な質量は例外、0 は無害', () => {
    const ledger = new ResourceLedger();
    assert.throws(() => ledger.add('titanium', -1));
    assert.throws(() => ledger.add('titanium', Number.NaN));
    assert.throws(() => ledger.take('titanium', -1));
    ledger.add('titanium', 0);
    assert.equal(ledger.amountOf('titanium'), 0);
    assert.equal(ledger.take('titanium', 0), true, '0 の取り出しは常に成功する');
    ledger.add('titanium', 10);
    ledger.clear();
    assert.equal(ledger.amountOf('titanium'), 0);
  });

  test('ResourceLedger: すべての資源 id を扱える', () => {
    const ledger = new ResourceLedger();
    for (const id of RESOURCE_IDS) ledger.add(id as ResourceId, 1);
    assert.equal(ledger.storedIds.length, RESOURCE_IDS.length);
  });
}
