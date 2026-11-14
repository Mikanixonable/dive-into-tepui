import * as assert from 'node:assert/strict';
import type { ShipAssembly } from '../../src/game/ship/ship-assembly';
import { ShipCapabilities } from '../../src/game/ship/ship-capabilities';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import { createShipModuleInstance } from '../../src/game/ship/ship-module-instance';
import { createBasePreset, createDefaultCombatPreset } from '../../src/game/ship/ship-presets';
import type { ConstructionTrial } from '../../src/game/ship/ship-construction-preview';
import {
  shipConstructionPanelModel, type ShipConstructionPanelSource,
} from '../../src/game/ship/ship-construction-panel-model';
import { deltaVBudget, effectiveExhaustVelocity } from '../../src/physics/rocket';
import { test } from '../harness';

// 表示モデルの材料のうち、性能の読み取りに関係しない欄は空で埋める。
function panelSource(assembly: ShipAssembly, trial: ConstructionTrial | null): ShipConstructionPanelSource {
  return {
    shipName: '試験船', assembly, anchorId: 'cockpit',
    held: null, heldBlueprintId: null, selection: null,
    orientation: { roll: 0, face: 'back' }, symmetry: 1,
    effective: null, pointedTargetId: null, trial,
    targets: [], history: { names: [], position: 0, canUndo: false, canRedo: false },
    blueprints: [],
  };
}

// 置き換え後の船体を載せた、有効な試し置きの結果を組む。
function trialOf(assembly: ShipAssembly): ConstructionTrial {
  return {
    valid: true, reason: null, placed: [], totals: assembly.totals(),
    healthyCockpitRemains: true, overlapModuleIds: [],
  };
}

// 建造パネルの表示モデル導出のテストを登録する。
export function register(): void {
  test('construction panel model: 主推進の無い船体は Δv と加速度が null', () => {
    // 基地 preset は thruster を持たない。
    const model = shipConstructionPanelModel(panelSource(createBasePreset(), null));
    assert.equal(model.capabilities.deltaV, null);
    assert.equal(model.capabilities.acceleration, null);
  });

  test('construction panel model: タンクを足した試し置きは Δv が増え加速度が減る', () => {
    const assembly = createDefaultCombatPreset();
    const withTank = assembly.clone();
    withTank.append(
      createShipModuleInstance(SHIP_MODULE_CATALOG.require('tank-combat-main'), 'extra-tank'),
    );
    const model = shipConstructionPanelModel(panelSource(assembly, trialOf(withTank)));

    const preview = model.preview?.capabilities;
    assert.ok(preview !== undefined);
    assert.ok(preview.deltaV !== null && model.capabilities.deltaV !== null);
    assert.ok(preview.acceleration !== null && model.capabilities.acceleration !== null);
    assert.ok(preview.deltaV > model.capabilities.deltaV);
    assert.ok(preview.acceleration < model.capabilities.acceleration);
  });

  // 建造の性能表示は、航法の計画が艦の Δv を出す式へ満載の値を入れた結果と一致する
  // (SPEC/UI-DESIGN.md「性能」)。消費率と単位あたり質量は艦が使う口から取り、
  // 満載質量と満載燃料はモジュール定義から独立に集計する。
  test('construction panel model: Δv は航法の計画の式へ満載値を入れた結果と一致する', () => {
    const assembly = createDefaultCombatPreset();
    const capabilities = new ShipCapabilities(assembly);
    const model = shipConstructionPanelModel(panelSource(assembly, null));

    const rate = capabilities.modules('thruster', true).reduce(
      (sum, module) => sum + (assembly.definition(module.id)?.abilities.fuelConsumptionRate ?? 0), 0,
    );
    const consumption = rate * capabilities.fuelMassPerUnit('main');
    const exhaustVel = effectiveExhaustVelocity(capabilities.totalThrust, consumption);
    let fullMass = 0, propellant = 0;
    for (const module of assembly.modules) {
      const definition = assembly.definition(module.id)!;
      fullMass += definition.dryMass;
      if (module.kind !== 'tank' && module.kind !== 'booster') continue;
      const kg = (definition.abilities.fuelCapacity ?? 0) * (definition.abilities.fuelMassPerUnit ?? 1);
      fullMass += kg;
      if (module.kind === 'tank' && module.fuelKind === 'main') propellant += kg;
    }
    const expected = deltaVBudget(exhaustVel, fullMass, propellant);

    assert.ok(model.capabilities.deltaV !== null);
    assert.ok(Math.abs(model.capabilities.deltaV - expected) < expected * 1e-9);
  });
}
