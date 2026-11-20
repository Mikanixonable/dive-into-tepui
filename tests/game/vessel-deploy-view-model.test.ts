// VESSEL パネルの展開部品の値が、積んでいる装備の有無で null になることを検証する。
import * as assert from 'node:assert/strict';
import { HudPanelPresenter } from '../../src/game/hud/hud-panel-presenter';
import type { VesselPanelViewModel } from '../../src/game/hud/panels/vessel-panel';
import { ModularShip } from '../../src/game/ship/modular-ship';
import type { ShipAssembly } from '../../src/game/ship/ship-assembly';
import { createBasePreset, createDefaultCombatPreset, createSalvageTenderPreset } from '../../src/game/ship/ship-presets';
import { DynamicMotion } from '../../src/game/dynamic/dynamic-motion';
import type { Controllable } from '../../src/game/dynamic/dynamic-entity/controllable';
import type { ViewMode } from '../../src/game/view/view-mode';
import { kinematicState } from '../../src/physics/kinematic-state';
import { v3 } from '../../src/math/vec3';
import { PowerSystem } from '../../src/game/player/power';
import { RadiatorSystem } from '../../src/game/player/radiator';
import { test } from '../harness';

const state = kinematicState<'eci'>(0, v3(), v3());

// assembly から展開物の系を組み、搭載に合わせる。
function deploySystems(assembly: ShipAssembly): { power: PowerSystem; radiator: RadiatorSystem } {
  const power = new PowerSystem(undefined, undefined, undefined, assembly);
  power.syncAssembly();
  const radiator = new RadiatorSystem(new DynamicMotion(state), () => {}, undefined, undefined, assembly);
  radiator.syncAssembly();
  return { power, radiator };
}

// 展開物の系だけを差し替えた操作対象のスタブを組む。燃料・姿勢は既定値。
function shipWithDeploySystems(
  systems: { power: PowerSystem; radiator: RadiatorSystem },
): ModularShip {
  const ship = Object.create(ModularShip.prototype) as ModularShip;
  Object.assign(ship, {
    mapKind: 'player',
    capabilities: {
      fuel: (kind: string) => kind === 'main' ? 75 : 12,
      maxFuel: (kind: string) => kind === 'main' ? 180 : 30,
    },
    motion: { power: systems.power, radiator: systems.radiator, aero: { qdyn: 0 } },
    throttle: { rcsDamp: false, throttleIdx: 0, progradeHold: false },
    _fineAttitude: false,
    fire: null,
  });
  return ship;
}

function vesselViewModel(ship: ModularShip): VesselPanelViewModel {
  const presenter = Object.create(HudPanelPresenter.prototype) as HudPanelPresenter;
  return (presenter as unknown as {
    vesselViewModel(controlled: Controllable, view: ViewMode): VesselPanelViewModel;
  }).vesselViewModel(ship, 'map');
}

export function register(): void {
  test('vessel deploy view model: 展開部品を積んでいない船は solar/radiator とも null', () => {
    // 補給艇は太陽電池も放熱板も積まない。系のオブジェクトはあっても、群ごと null になる。
    const viewModel = vesselViewModel(shipWithDeploySystems(deploySystems(createSalvageTenderPreset([]))));
    assert.equal(viewModel.solar, null);
    assert.equal(viewModel.radiator, null);
  });

  test('vessel deploy view model: 標準戦闘艦はパドル両側と放熱板の片側だけ値を渡す', () => {
    // 標準戦闘艦は太陽電池2枚・放熱板1枚を積む。放熱板の無い側は null になる。
    const viewModel = vesselViewModel(shipWithDeploySystems(deploySystems(createDefaultCombatPreset())));
    assert.deepEqual(viewModel.solar, {
      up: { deploy: 1, wear: 0 },
      down: { deploy: 1, wear: 0 },
    });
    assert.deepEqual(viewModel.radiator, {
      up: { deploy: 0, wear: 0 },
      down: null,
    });
  });

  test('vessel deploy view model: 基地は両群とも両側の値を渡す', () => {
    // 基地は太陽電池・放熱板を2枚ずつ積む。
    const viewModel = vesselViewModel(shipWithDeploySystems(deploySystems(createBasePreset())));
    assert.deepEqual(viewModel.solar, {
      up: { deploy: 1, wear: 0 },
      down: { deploy: 1, wear: 0 },
    });
    assert.deepEqual(viewModel.radiator, {
      up: { deploy: 0, wear: 0 },
      down: { deploy: 0, wear: 0 },
    });
  });

  test('vessel deploy view model: 片方だけの船は積んでいる側だけ残る', () => {
    // 太陽電池は戦闘艦の系、放熱板は補給艇の系と、系ごとに有無を変える。
    const combat = deploySystems(createDefaultCombatPreset());
    const tender = deploySystems(createSalvageTenderPreset([]));
    const viewModel = vesselViewModel(shipWithDeploySystems({ power: combat.power, radiator: tender.radiator }));
    assert.notEqual(viewModel.solar, null);
    assert.equal(viewModel.radiator, null);
  });
}
