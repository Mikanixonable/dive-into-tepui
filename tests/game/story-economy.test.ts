// ストーリーの経済の台帳と価格規則が、GAME.md 11.4 の規則どおりであることを検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { RunEventLog } from '../../src/game/run-events';
import {
  StoryEconomy, enemyDropMaterials, moduleMaterialsCost, repairMaterialsCost,
  MAGAZINE_MATERIALS, LUNAR_BASE_MATERIALS_PER_HOUR, LUNAR_BASE_PROPELLANT_PER_HOUR,
} from '../../src/game/campaign/story-economy';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import { ShipAssembly } from '../../src/game/ship/ship-assembly';
import { createShipModuleInstance } from '../../src/game/ship/ship-module-instance';

export function register(): void {
  test('story-economy: モジュール価格は乾燥質量で決まり、大型ほど非線形に高い', () => {
    const solar = SHIP_MODULE_CATALOG.require('solar-panel-standard');
    const thruster = SHIP_MODULE_CATALOG.require('thruster-standard');
    const tank = SHIP_MODULE_CATALOG.require('tank-6-main');
    assert.equal(moduleMaterialsCost(solar), 2);
    assert.equal(moduleMaterialsCost(thruster), 12);
    assert.equal(moduleMaterialsCost(tank), 82);
    // 質量あたりの単価は、大型モジュールほど高い(線形ではない)。
    assert.ok(moduleMaterialsCost(tank) / tank.dryMass > moduleMaterialsCost(thruster) / thruster.dryMass);
  });

  test('story-economy: 修理費は損傷した価格の3割で、無傷なら0', () => {
    const assembly = new ShipAssembly(SHIP_MODULE_CATALOG, true);
    const tank = createShipModuleInstance(SHIP_MODULE_CATALOG.require('tank-6-main'), 'tank');
    assembly.addRoot(tank);
    assert.equal(repairMaterialsCost(assembly), 0);
    // 半壊(40/80 HP)なら価格 82 の半分の3割 → 13(切り上げ)。
    assembly.setHp('tank', 40);
    assert.equal(repairMaterialsCost(assembly), 13);
  });

  test('story-economy: 敵ドロップは基礎量に質量分が乗り、上限で止まる', () => {
    assert.equal(enemyDropMaterials(0), 20);
    assert.equal(enemyDropMaterials(2000), 30);
    assert.equal(enemyDropMaterials(1_000_000), 120);
  });

  test('story-economy: 支払いは備蓄の範囲内だけで成立し、増減が出来事になる', () => {
    const events = new RunEventLog();
    const economy = new StoryEconomy(events, { 'lunar-base': { materials: 100, propellant: 50 } });
    assert.equal(economy.charge('lunar-base', 30, 0), true);
    assert.deepEqual(economy.stockpileOf('lunar-base'), { materials: 70, propellant: 50 });
    // 足りない支払いは何も変えない。
    assert.equal(economy.charge('lunar-base', 71, 0), false);
    assert.equal(economy.charge('lunar-base', 0, 51), false);
    assert.deepEqual(economy.stockpileOf('lunar-base'), { materials: 70, propellant: 50 });
    // 返金は備蓄へ戻り、出来事にも出る。
    economy.refund('lunar-base', 10, 5);
    assert.deepEqual(economy.stockpileOf('lunar-base'), { materials: 80, propellant: 55 });
    assert.deepEqual(
      events.recent.map(({ body }) => body),
      [
        { kind: 'stockpileChanged', baseId: 'lunar-base', materials: -30, propellant: 0 },
        { kind: 'stockpileChanged', baseId: 'lunar-base', materials: 10, propellant: 5 },
      ],
    );
  });

  test('story-economy: 建造の完了は質量が台帳へ積まれ、出来事としてキャンペーンへ送られる', () => {
    // GAME.md 11.3: 評価の「建造した総質量」は、完了した建造の乾燥質量の累計である。
    const events = new RunEventLog();
    const economy = new StoryEconomy(events);
    economy.recordConstructionCompleted(1200);
    economy.recordConstructionCompleted(0);
    economy.recordConstructionCompleted(300);
    assert.equal(economy.builtMassKg, 1500);
    assert.deepEqual(
      events.recent.map(({ body }) => body),
      [
        { kind: 'storyConstructionCompleted', massKg: 1200 },
        { kind: 'storyConstructionCompleted', massKg: 300 },
      ],
    );
    // 直列化を往復しても、このランぶんの合計は残る。
    const restored = StoryEconomy.deserialize(economy.serialize(), new RunEventLog());
    assert.equal(restored.builtMassKg, 1500);
  });

  test('story-economy: 回収の積み増しは出来事を出さない(同期は回収の出来事が持つ)', () => {
    const events = new RunEventLog();
    const economy = new StoryEconomy(events);
    economy.credit('lunar-base', 120, 0);
    assert.deepEqual(economy.stockpileOf('lunar-base'), { materials: 120, propellant: 0 });
    assert.equal(events.recent.length, 0);
  });

  test('story-economy: 生産は端数を抱えて整数分だけ積まれ、能動回収に劣る速さである', () => {
    const events = new RunEventLog();
    const economy = new StoryEconomy(events);
    // 10 分で素材 1(6/時)と推進剤 5(30/時)。
    economy.produce('lunar-base', LUNAR_BASE_MATERIALS_PER_HOUR, LUNAR_BASE_PROPELLANT_PER_HOUR, 600);
    assert.deepEqual(economy.stockpileOf('lunar-base'), { materials: 1, propellant: 5 });
    // さらに 10 分で同量が積まれる。
    economy.produce('lunar-base', LUNAR_BASE_MATERIALS_PER_HOUR, LUNAR_BASE_PROPELLANT_PER_HOUR, 600);
    assert.deepEqual(economy.stockpileOf('lunar-base'), { materials: 2, propellant: 10 });
    // 1 時間ぶんでも素材 6 — デブリ回収 1 回(120)には遠く及ばない。
    const hour = new StoryEconomy(new RunEventLog());
    hour.produce('lunar-base', LUNAR_BASE_MATERIALS_PER_HOUR, LUNAR_BASE_PROPELLANT_PER_HOUR, 3600);
    assert.equal(hour.stockpileOf('lunar-base').materials, 6);
    // 台帳は直列化の往復で保たれる(端数も含む)。
    const restored = StoryEconomy.deserialize(economy.serialize(), new RunEventLog());
    assert.deepEqual(restored.serialize(), economy.serialize());
    assert.equal(MAGAZINE_MATERIALS, 5);
  });
}
