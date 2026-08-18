import * as assert from 'node:assert/strict';
import { test } from '../physics/harness';
import { canFeedAmmo, canLoad, consumeRound, loadPayload, releasePayload } from '../../src/game/vessel/payload';

export function register(): void {
  test('payload bay enforces both volume and mass', () => {
    const bay = { volume: 10, maxPayloadMass: 5, items: [] };
    const item = { id: 'a', kind: 'ammunition' as const, typeId: 'round', volume: 2, mass: 3 };
    assert.equal(canLoad(bay, item).accepted, true);
    const loaded = loadPayload(bay, item);
    assert.equal(releasePayload(loaded, 'a').bay.items.length, 0);
    assert.equal(canLoad(loaded, { ...item, id: 'b', mass: 3 }).reason, 'mass');
  });
  test('ammo is unavailable after its magazine stage is separated', () => {
    const state = { weaponType: 'gatling', magazineStageId: 'stage-1', weaponStageId: 'stage-2', loadedRounds: 1, maxLoadedRounds: 32 };
    assert.equal(canFeedAmmo(state), false);
    assert.equal(consumeRound(state).loadedRounds, 0);
  });
}
