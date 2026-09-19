import * as assert from 'node:assert/strict';
import { ShipAssembly } from '../../src/game/ship/ship-assembly';
import { ShipDockState } from '../../src/game/ship/ship-dock-state';
import { createBasePreset } from '../../src/game/ship/ship-presets';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import { createShipModuleInstance } from '../../src/game/ship/ship-module-instance';
import { test } from '../harness';

export function register(): void {
  test('ship construction: dock draft lifecycle is resumable and serializable', () => {
    const assembly = createBasePreset();
    const docks = new ShipDockState();

    assert.equal(docks.status(assembly, 'dock-left'), 'empty');
    docks.beginBuilding(assembly, 'dock-left');
    assert.equal(docks.status(assembly, 'dock-left'), 'building');
    assert.deepEqual(docks.constructionDraft('dock-left'), {
      dockId: 'dock-left', addedIds: [], axialTailId: 'dock-left', firstConnectionId: null,
    });

    docks.updateConstructionDraft({
      dockId: 'dock-left', addedIds: ['branch-1'], axialTailId: 'branch-1', firstConnectionId: 'edge-1',
    });
    const saved = docks.serialize();
    assert.deepEqual(saved, [{
      dockId: 'dock-left', addedIds: ['branch-1'], axialTailId: 'branch-1', firstConnectionId: 'edge-1',
    }]);

    const resumed = new ShipDockState(saved);
    const resumedDraft = resumed.constructionDraft('dock-left');
    assert.deepEqual(resumedDraft, saved[0]);
    assert.equal(resumed.status(assembly, 'dock-left'), 'building');

    resumed.finishBuilding('dock-left');
    assert.equal(resumed.status(assembly, 'dock-left'), 'empty');
  });

  test('ship construction: a connected dock takes precedence over a construction draft', () => {
    const host = createBasePreset();
    const guest = new ShipAssembly(SHIP_MODULE_CATALOG, true);
    guest.addRoot(createShipModuleInstance(
      SHIP_MODULE_CATALOG.require('docking-port-standard'), 'port',
    ));
    const merged = host.mergedAtDock(guest, 'dock-left', 'port', 'guest');
    const docks = new ShipDockState([{
      dockId: 'dock-left', addedIds: [], axialTailId: 'dock-left', firstConnectionId: null,
    }]);

    assert.equal(docks.status(merged.assembly, 'dock-left'), 'connected');
  });
}
