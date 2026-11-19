import * as assert from 'node:assert/strict';
import { HudPanelPresenter } from '../../src/game/hud/hud-panel-presenter';
import type { AmmoViewModel } from '../../src/game/hud/ammo-status';
import { ModularShip } from '../../src/game/ship/modular-ship';
import type { Controllable } from '../../src/game/dynamic/dynamic-entity/controllable';
import { test } from '../harness';

export function register(): void {
  test('armament band view model: 弾薬と弾速を渡す', () => {
    const ship = Object.create(ModularShip.prototype) as ModularShip;
    Object.assign(ship, {
      capabilities: { averageMuzzleVelocity: 1000 },
      fire: { rounds: 18, mags: 2, cooldown: 0 },
    });
    const presenter = Object.create(HudPanelPresenter.prototype) as HudPanelPresenter;
    const ammo = (presenter as unknown as {
      ammoViewModel(controlled: Controllable): AmmoViewModel | null;
    }).ammoViewModel(ship);

    assert.deepEqual(ammo, { rounds: 18, mags: 2, cooldown: 0, muzzleVelocityMps: 1000 });
  });

  test('armament band view model: 機関砲が無ければ null', () => {
    const ship = Object.create(ModularShip.prototype) as ModularShip;
    Object.assign(ship, {
      capabilities: { averageMuzzleVelocity: 1000 },
      fire: null,
    });
    const presenter = Object.create(HudPanelPresenter.prototype) as HudPanelPresenter;
    const ammo = (presenter as unknown as {
      ammoViewModel(controlled: Controllable): AmmoViewModel | null;
    }).ammoViewModel(ship);

    assert.equal(ammo, null);
  });
}
