import * as assert from 'node:assert/strict';
import { HudPanelPresenter } from '../../src/game/hud/hud-panel-presenter';
import { reloadDisabledReason, type AmmoViewModel } from '../../src/game/hud/ammo-status';
import { MAG_ROUNDS } from '../../src/game/player/ammo-spec';
import { ModularShip } from '../../src/game/ship/modular-ship';
import type { Controllable } from '../../src/game/dynamic/dynamic-entity/controllable';
import { test } from '../harness';

export function register(): void {
  test('armament band view model: 弾薬と弾速を渡す', () => {
    const ship = Object.create(ModularShip.prototype) as ModularShip;
    Object.assign(ship, {
      mapKind: 'player',
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

  test('reload disabled reason: 弾切れは装填できない', () => {
    const ammo: AmmoViewModel = { rounds: 0, mags: 0, cooldown: 0, muzzleVelocityMps: 1000 };
    assert.equal(reloadDisabledReason(ammo), '弾切れのため装填できません');
  });

  test('reload disabled reason: 弾切れはクールダウン中も同じ理由', () => {
    const ammo: AmmoViewModel = { rounds: 0, mags: 0, cooldown: 1, muzzleVelocityMps: 1000 };
    assert.equal(reloadDisabledReason(ammo), '弾切れのため装填できません');
  });

  test('reload disabled reason: 弾倉が満杯のとき装填できない', () => {
    const ammo: AmmoViewModel = { rounds: MAG_ROUNDS, mags: 2, cooldown: 0, muzzleVelocityMps: 1000 };
    assert.equal(reloadDisabledReason(ammo), '弾倉は満杯です');
  });

  test('reload disabled reason: 弾帯が空でも予備があれば装填できる', () => {
    const ammo: AmmoViewModel = { rounds: 0, mags: 1, cooldown: 0, muzzleVelocityMps: 1000 };
    assert.equal(reloadDisabledReason(ammo), null);
  });

  test('reload disabled reason: クールダウンだけでは無効にしない', () => {
    const ammo: AmmoViewModel = { rounds: 18, mags: 2, cooldown: 0.5, muzzleVelocityMps: 1000 };
    assert.equal(reloadDisabledReason(ammo), null);
  });

  test('reload disabled reason: 残弾があるとき装填できる', () => {
    const ammo: AmmoViewModel = { rounds: 18, mags: 2, cooldown: 0, muzzleVelocityMps: 1000 };
    assert.equal(reloadDisabledReason(ammo), null);
  });
}
