import * as assert from 'node:assert/strict';
import { HudPanelPresenter } from '../../src/game/hud/hud-panel-presenter';
import { ModularShip } from '../../src/game/ship/modular-ship';
import type { Controllable } from '../../src/game/dynamic/entity/controllable';
import type { ViewMode } from '../../src/game/view/view-mode';
import { test } from '../harness';

export function register(): void {
  test('vessel fuel view model: 主推進燃料と RCS 燃料を別々に渡す', () => {
    const ship = Object.create(ModularShip.prototype) as ModularShip;
    Object.assign(ship, {
      mapKind: 'player',
      capabilities: {
        fuel: (kind: string) => kind === 'main' ? 75 : 12,
        maxFuel: (kind: string) => kind === 'main' ? 180 : 30,
      },
      motion: { power: null, radiator: null, aero: { qdyn: 0 } },
      throttle: { rcsDamp: false, throttleIdx: 0, progradeHold: false },
      _fineAttitude: false,
      fire: null,
    });
    const presenter = Object.create(HudPanelPresenter.prototype) as HudPanelPresenter;
    Object.assign(presenter, { viewer: { camera: { combat: { rotationFollow: null } } } });
    const viewModel = (presenter as unknown as {
      vesselViewModel(controlled: Controllable, view: ViewMode): {
        mainFuel: number;
        maxMainFuel: number;
        rcsFuel: number;
        maxRcsFuel: number;
      };
    }).vesselViewModel(ship, 'map');

    assert.deepEqual(
      [viewModel.mainFuel, viewModel.maxMainFuel, viewModel.rcsFuel, viewModel.maxRcsFuel],
      [75, 180, 12, 30],
    );
  });
}
