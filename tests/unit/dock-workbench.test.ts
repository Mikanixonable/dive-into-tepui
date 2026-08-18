import * as assert from 'node:assert/strict';
import { removePlacement } from '../../src/game/vessel/assembly-editor';
import { mateVerdict } from '../../src/game/vessel/assembly-mode';
import { DockWorkbenchSession, type WorkbenchSnapshot } from '../../src/game/vessel/dock-workbench';
import { DockWorkbenchController } from '../../src/game/vessel/dock-workbench-controller';
import { createPart } from '../../src/game/game-entity/parts';
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

  test('normalizes legacy targets and preserves base, docked, and draft kinds', () => {
    const assembly = crewedAssembly(1000);
    const session = new DockWorkbenchSession({
      targets: [
        { id: 'base', kind: 'base', assembly },
        { id: 'ship-a', assembly },
      ],
      inventory: [],
    }, () => ({ valid: true, errors: [] }));

    assert.equal(session.targetKind('base'), 'base');
    assert.equal(session.targetKind('ship-a'), 'docked-vessel');
    const draft = session.createNewVesselDraft('draft-a', assembly);
    assert.equal(draft.kind, 'new-vessel-draft');
    assert.equal(session.snapshot().targets[2]!.kind, 'new-vessel-draft');
  });

  test('applies an assembly-editor result as one undoable command', () => {
    const assembly = crewedAssembly(1000);
    const removable = assembly.placements[0]!.part;
    const session = new DockWorkbenchSession({
      targets: [{ id: 'ship-a', kind: 'docked-vessel', assembly }], inventory: [],
    }, () => ({ valid: true, errors: [] }));
    const edit = removePlacement(assembly, removable.id, { validateBlueprint: false });
    assert.equal(edit.accepted, true);

    const validation = session.applyAssemblyEdit('ship-a', edit, '外装部品を編集');
    assert.equal(validation.valid, true);
    assert.equal(session.snapshot().targets[0]!.assembly.placements.some((p) => p.part.id === removable.id), false);
    assert.equal(session.undoHistory.at(-1)!.label, '外装部品を編集');
    assert.equal(session.undo(), true);
    assert.equal(session.snapshot().targets[0]!.assembly.placements.some((p) => p.part.id === removable.id), true);
    assert.equal(session.redo(), true);
  });

  test('target validators can reject a base edit without losing the previous snapshot', () => {
    const assembly = crewedAssembly(1000);
    const session = new DockWorkbenchSession({
      targets: [{ id: 'base', kind: 'base', assembly }], inventory: [],
    }, () => ({ valid: true, errors: [] }), {
      targetValidator: (target) => target.kind === 'base'
        ? { valid: false, errors: ['基地には専用の検証が必要です'] }
        : { valid: true, errors: [] },
    });
    const before = session.snapshot();
    const edit = removePlacement(assembly, assembly.placements[0]!.part.id, { validateBlueprint: false });
    const validation = session.applyEditResult('base', edit);
    assert.equal(validation.valid, false);
    assert.deepEqual(session.snapshot(), before);
    assert.equal(session.canUndo, false);
  });

  test('inventory movement, draft cancellation, and build snapshots are isolated', () => {
    const assembly = crewedAssembly(1000);
    const removable = assembly.placements[0]!.part;
    const session = new DockWorkbenchSession({
      targets: [{ id: 'ship-a', kind: 'docked-vessel', assembly }], inventory: [],
    }, () => ({ valid: true, errors: [] }));
    session.removePlacement('ship-a', removable.id);
    assert.equal(session.inventorySnapshot()[0]!.id, removable.id);
    const snapshot = session.snapshotBeforeBuild();
    (snapshot.inventory[0] as { name: string }).name = '外部変更';
    assert.equal(session.inventorySnapshot()[0]!.name, removable.name);

    session.createNewVesselDraft('draft-a', assembly);
    assert.equal(session.dirty, true);
    session.cancel();
    assert.equal(session.snapshot().targets.some((target) => target.id === 'draft-a'), false);
    assert.equal(session.dirty, false);
    assert.equal(session.canUndo, false);
  });

  test('controller carries target kinds through drag/drop and exposes session commands', () => {
    const assembly = crewedAssembly(1000);
    const edge = assembly.tree.edges.find((candidate) => candidate.kind.kind === 'hull')!;
    const antenna = createPart('communication', { id: 'workbench-antenna', name: 'Workbench antenna' });
    const session = new DockWorkbenchSession({
      targets: [{ id: 'base', kind: 'base', assembly }], inventory: [antenna],
    }, () => ({ valid: true, errors: [] }));
    const controller = new DockWorkbenchController(session);
    controller.beginDrag(antenna, null, true);
    controller.updateCandidate({
      placement: {
        kind: 'external', part: antenna,
        mount: { kind: 'surface', edgeId: edge.id, along: 0, around: 0 },
      },
      verdict: mateVerdict({ occupied: false, widthFits: true, phaseFits: true, lengthFits: true, withinWorkArea: true }),
      targetLabel: '基地', position: { x: 0, y: 0, z: 0 }, targetKind: 'base',
    });
    assert.equal(controller.dragging!.sourceTargetKind, null);
    assert.equal(controller.drop('base').valid, true);
    assert.equal(session.inventorySnapshot().length, 0);
    assert.equal(controller.undo(), true);
    assert.equal(session.inventorySnapshot()[0]!.id, antenna.id);
    controller.createNewVesselDraft('draft-a', assembly);
    controller.cancel();
    assert.equal(session.snapshot().targets.some((target) => target.id === 'draft-a'), false);
  });
}
