import * as assert from 'node:assert/strict';
import { test } from '../physics/harness';
import { addToPartStock, mateVerdict, partOrder, partOrderProducibility, rebuildPlan } from '../../src/game/vessel/assembly-mode';
import { createPart } from '../../src/game/game-entity/parts';
import { ResourceLedger } from '../../src/game/economy/resource-ledger';
import { createBlueprint } from '../../src/game/vessel/blueprint';

export function register(): void {
  test('assembly mode rejects each invalid mating condition', () => {
    const result = mateVerdict({ occupied: true, widthFits: false, phaseFits: true, lengthFits: false, withinWorkArea: true });
    assert.deepEqual(result.failures, ['occupied', 'section-fit', 'length']);
  });
  test('part stock and producibility use the existing build-cost table', () => {
    const part = createPart('cockpit', { weight: 10 });
    const stock = addToPartStock({ orders: [] }, partOrder(part));
    assert.equal(stock.orders.length, 1);
    assert.ok(partOrderProducibility(part, new ResourceLedger()).length > 0);
    const bp = createBlueprint({ id: 'x', name: 'x', now: 0, tree: { nodes: [], edges: [] }, placements: [] });
    assert.deepEqual(rebuildPlan(bp), []);
  });
}
