import * as assert from 'node:assert/strict';
import { test } from '../physics/harness';
import { pickModule } from '../../src/game/vessel/module-pick';
import { communicationPanelState, stagePanelState } from '../../src/game/hud/flight-panels';

export function register(): void {
  test('module pick falls back to control and keeps panel state display-only', () => {
    const assembly = { tree: { nodes: [], edges: [] }, placements: [] } as never;
    assert.deepEqual(pickModule(assembly, 0, 0, () => ({ x: 0, y: 0, visible: false, diameterPx: 0 }), 12), { kind: 'control' });
    assert.deepEqual(communicationPanelState(false, 'relay-1', -2), { inRange: false, nearestRelay: 'relay-1', rangeMargin: -2 });
    assert.deepEqual(stagePanelState([{ id: 's1', remainingDv: 10 }], 's1').stages[0], { id: 's1', remainingDv: 10, next: true });
  });
}
