import * as assert from 'node:assert/strict';
import { DockWorkbenchSession, type WorkbenchSnapshot } from '../../src/game/vessel/dock-workbench';
import { crewedAssembly } from '../../src/game/vessel/vessel-assemblies';
import { test } from '../physics/harness';

export function register(): void {
  test('dock workbench edits are isolated until validation/apply', () => {
    const assembly = crewedAssembly(1000);
    const removable = assembly.placements[0]!.part;
    const snapshot: WorkbenchSnapshot = { targets: [{ id: 'ship-a', assembly }], inventory: [] };
    const session = new DockWorkbenchSession(snapshot, () => ({ valid: true, errors: [] }));
    session.removePlacement('ship-a', removable.id);
    assert.equal(session.dirty, true);
    assert.equal(snapshot.targets[0]!.assembly.placements.length, assembly.placements.length);
    session.discardChanges();
    assert.equal(session.dirty, false);
    assert.equal(session.validate().valid, true);
  });

  test('dock workbench undo and redo restore both inventory and placements', () => {
    const assembly = crewedAssembly(1000);
    const removable = assembly.placements[0]!.part;
    const session = new DockWorkbenchSession(
      { targets: [{ id: 'ship-a', assembly }], inventory: [] },
      () => ({ valid: true, errors: [] }),
    );
    session.removePlacement('ship-a', removable.id);
    assert.equal(session.canUndo, true);
    assert.equal(session.snapshot().inventory[0]!.id, removable.id);
    assert.equal(session.undo(), true);
    assert.equal(session.snapshot().inventory.length, 0);
    assert.equal(session.redo(), true);
    assert.equal(session.snapshot().inventory[0]!.id, removable.id);
  });
}
