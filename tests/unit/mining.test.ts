import * as assert from 'node:assert/strict';
import { test } from '../physics/harness';
import { cargoPropellantMass, mine, transferResources } from '../../src/game/economy/mining';
import { ResourceLedger } from '../../src/game/economy/resource-ledger';

export function register(): void {
  test('moon mining produces only at a matching deposit and transfers through a connected link', () => {
    const source = new ResourceLedger(); const target = new ResourceLedger();
    const result = mine({ bodyId: 'moon', access: 'regolith', latRad: -1.4, lonRad: 0 }, 'regolith', 2, 10, source, 100);
    assert.ok(result.mined > 0);
    assert.equal(transferResources(source, target, 'regolith', 10, { connected: true, rateKgPerSecond: 1 }, 10), 10);
    assert.ok(cargoPropellantMass(1000, 100, 1000, 320) > cargoPropellantMass(1000, 0, 1000, 320));
  });
}
