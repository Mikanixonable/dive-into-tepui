import * as assert from 'node:assert/strict';
import { ShipAssembly } from '../../src/game/ship/ship-assembly';
import { ShipDockState } from '../../src/game/ship/ship-dock-state';
import { createBasePreset } from '../../src/game/ship/ship-presets';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import { createShipModuleInstance } from '../../src/game/ship/ship-module-instance';
import { enumerateConstructionSlots, placementForSlot } from '../../src/game/ship/ship-construction-rules';
import { restoreConstructionDrafts, restoreDockedVessels } from '../../src/game/ship/ship-save';
import { CommandQueue } from '../../src/game/command-queue';
import { CommandCompletion } from '../../src/game/command-completion';
import { ShipConstructionEdits, type ConstructionShip } from '../../src/game/ship/ship-construction-edits';
import { ShipCapabilities } from '../../src/game/ship/ship-capabilities';
import { ModularShipMotion } from '../../src/game/ship/modular-ship-motion';
import { kinematicState } from '../../src/physics/kinematic-state';
import { test } from '../harness';
import { constructionCandidate, hitsConstructionCandidate } from '../../src/game/ship/ship-construction-candidates';
import { LOCAL_FORWARD, LOCAL_UP, Q_IDENTITY, qFromAxisAngle, qRotate } from '../../src/math/quat';
import { add, sub, scale, len, v3 } from '../../src/math/vec3';

// 船体構成・予約・運動を実部品で組み、構造編集後の物性を更新する。
class ConstructionTestShip implements ConstructionShip {
  public readonly assembly = createBasePreset();
  public readonly docks = new ShipDockState();
  public readonly capabilities = new ShipCapabilities(this.assembly);
  public readonly motion = new ModularShipMotion(
    this.assembly, kinematicState<'eci'>(0, v3(100, 200, 300), v3()),
    { q: Q_IDENTITY, w: v3(), inertia: v3(1, 1, 1) },
  );

  // 質量特性と操作基準を編集済み船体へ合わせる。
  public synchronizeAssemblyState(): void {
    this.motion.synchronizeAssembly();
    this.capabilities.reconcileOperatingCockpit();
  }
}

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

  test('ship construction: all free cockpit and tank side slots are enumerated', () => {
    const assembly = createBasePreset();
    const slots = enumerateConstructionSlots(
      assembly, ['dock-left', 'cockpit', 'main-tank', 'rcs-tank'], 'rcs-tank',
    );
    assert.equal(slots[0]?.id, 'axial');
    assert.ok(slots.some(slot => slot.id === 'main-tank:side+y'));
    assert.ok(slots.some(slot => slot.id === 'rcs-tank:side-y'));
    assert.equal(slots.some(slot => slot.id === 'cockpit:side+y'), false);
    assert.equal(new Set(slots.map(slot => slot.id)).size, slots.length);
  });

  test('ship construction: placement rules allow side equipment on any eligible parent', () => {
    const assembly = createBasePreset();
    const slot = enumerateConstructionSlots(
      assembly, ['dock-left', 'cockpit', 'main-tank', 'rcs-tank'], 'rcs-tank',
    ).find(candidate => candidate.id === 'main-tank:side+y');
    assert.ok(slot);
    const dockingPort = SHIP_MODULE_CATALOG.require('docking-port-standard');
    const sidePlacement = placementForSlot(assembly, slot, dockingPort);
    assert.equal(sidePlacement.valid, true);
    assert.equal(sidePlacement.kind, 'side');

    const cockpit = SHIP_MODULE_CATALOG.require('cockpit-standard');
    const axial = enumerateConstructionSlots(assembly, ['dock-left'], 'rcs-tank')[0];
    assert.ok(axial);
    assert.equal(placementForSlot(assembly, axial, cockpit).valid, true);
    const solar = SHIP_MODULE_CATALOG.require('solar-panel-standard');
    assert.equal(placementForSlot(assembly, axial, solar).valid, false);
  });

  test('ship construction: dock axial slot points +Z outward with inverted rotation', () => {
    const assembly = createBasePreset();
    const dockSlots = enumerateConstructionSlots(assembly, ['dock-left'], 'dock-left');
    assert.equal(dockSlots[0]?.id, 'axial');
    assert.equal(dockSlots[0]?.direction.z, 1);

    const cockpit = SHIP_MODULE_CATALOG.require('cockpit-standard');
    const placement = placementForSlot(assembly, dockSlots[0], cockpit);
    assert.equal(placement.valid, true);
    assert.equal(placement.transform.position.z, (1 + 9) / 2);
    assert.equal(placement.transform.rotation.y, 1);
  });

  test('ship construction: catalog definitions expose presentation metadata', () => {
    assert.equal(SHIP_MODULE_CATALOG.require('cockpit-standard').name, 'コックピット');
    assert.equal(SHIP_MODULE_CATALOG.require('tank-6-main').category, 'fuel');
    assert.equal(SHIP_MODULE_CATALOG.require('weapon-gatling').category, 'combat');
  });

  test('ship construction: 候補位置は船体の平行移動と回転に従う', () => {
    const assembly = createBasePreset();
    const definition = SHIP_MODULE_CATALOG.require('cockpit-standard');
    const slots = enumerateConstructionSlots(assembly, ['dock-left', 'main-tank'], 'dock-left');
    const position = v3(700, -30, 80); // ECI [m]
    const offset = v3(1, 2, 3); // 船体内重心 [m]
    const rotation = qFromAxisAngle(LOCAL_UP, Math.PI / 3);
    for (const slot of slots) {
      const local = constructionCandidate(assembly, slot, definition, v3(), Q_IDENTITY, offset);
      const world = constructionCandidate(assembly, slot, definition, position, rotation, offset);
      assert.ok(local !== null && world !== null);
      assert.ok(len(sub(world.centerEci, add(position, qRotate(rotation, local.centerEci)))) < 1e-9);
      assert.ok(len(sub(world.guideEci, add(position, qRotate(rotation, local.guideEci)))) < 1e-9);
      assert.equal(world.placement.valid, local.placement.valid);
      assert.equal(world.guideRadius, local.guideRadius);
    }
  });

  test('ship construction: 円盤は前方の交差を受け、背後と平行の視線を拒否する', () => {
    const assembly = createBasePreset();
    const slot = enumerateConstructionSlots(assembly, ['dock-left'], 'dock-left')[0];
    assert.ok(slot !== undefined);
    const candidate = constructionCandidate(
      assembly, slot, SHIP_MODULE_CATALOG.require('cockpit-standard'),
      v3(700, -30, 80), qFromAxisAngle(LOCAL_UP, Math.PI / 3), v3(1, 2, 3),
    );
    assert.ok(candidate !== null);
    const normal = qRotate(candidate.rotationEci, LOCAL_FORWARD);
    const origin = add(candidate.guideEci, scale(normal, 10));
    assert.equal(hitsConstructionCandidate({ origin, dir: scale(normal, -1) }, candidate, false), true);
    assert.equal(hitsConstructionCandidate({ origin, dir: normal }, candidate, false), false);
    const tangent = qRotate(candidate.rotationEci, LOCAL_UP);
    assert.equal(hitsConstructionCandidate({ origin, dir: tangent }, candidate, false), false);
    const outside = add(origin, scale(tangent, candidate.guideRadius * 2));
    assert.equal(hitsConstructionCandidate({ origin: outside, dir: scale(normal, -1) }, candidate, false), false);
  });

  test('ship construction: 保存ドラフトは追加枝と重複IDを検証する', () => {
    const assembly = new ShipAssembly(SHIP_MODULE_CATALOG, true);
    assembly.addRoot(createShipModuleInstance(
      SHIP_MODULE_CATALOG.require('dock-standard'), 'dock',
    ));
    assembly.append(createShipModuleInstance(
      SHIP_MODULE_CATALOG.require('tank-3-main'), 'tank',
    ), 'dock');
    const edge = assembly.graph[0];
    assert.ok(edge !== undefined);
    assert.deepEqual(restoreConstructionDrafts([{
      dockId: 'dock', addedIds: ['tank'], axialTailId: 'tank', firstConnectionId: edge.id,
    }], assembly), [{
      dockId: 'dock', addedIds: ['tank'], axialTailId: 'tank', firstConnectionId: edge.id,
    }]);
    assert.throws(() => restoreConstructionDrafts([{
      dockId: 'dock', addedIds: ['tank', 'tank'], axialTailId: 'tank', firstConnectionId: edge.id,
    }], assembly), /invalid construction draft/);
    assert.throws(() => restoreConstructionDrafts([{
      dockId: 'dock', addedIds: 'tank' as unknown as readonly string[],
      axialTailId: 'dock', firstConnectionId: null,
    }], assembly), /invalid construction draft/);
  });

  test('ship construction: 保存された docking identity は全 edge と一対一である', () => {
    const host = createBasePreset();
    const guest = new ShipAssembly(SHIP_MODULE_CATALOG, true);
    guest.addRoot(createShipModuleInstance(
      SHIP_MODULE_CATALOG.require('docking-port-standard'), 'port',
    ));
    const merged = host.mergedAtDock(guest, 'dock-left', 'port', 'guest');
    assert.deepEqual(restoreDockedVessels([{
      connectionId: merged.connectionId, id: 'guest-ship', name: 'guest',
    }], merged.assembly), [{
      connectionId: merged.connectionId, id: 'guest-ship', name: 'guest',
    }]);
    assert.throws(() => restoreDockedVessels([], merged.assembly), /do not match docking connections/);
  });
  test('ship construction: 命令を順に適用し、予約と構成と物性を同時に更新する', () => {
    const ship = new ConstructionTestShip();
    const edits = new ShipConstructionEdits(ship, 'dock-left');
    const queue = new CommandQueue();
    const start = new CommandCompletion();
    const first = new CommandCompletion();
    const second = new CommandCompletion();
    queue.submitWithCompletion(() => edits.begin(), start);
    queue.submitWithCompletion(() => edits.place('cockpit-standard', 'axial', 'branch-cockpit'), first);
    queue.submitWithCompletion(() => edits.place('tank-3-main', 'axial', 'branch-tank'), second);
    assert.equal(ship.docks.constructionDraft('dock-left'), null);
    assert.equal(ship.assembly.module('branch-cockpit'), null);

    queue.applyAll();
    assert.equal(start.state.kind, 'succeeded');
    assert.equal(first.state.kind, 'succeeded');
    assert.equal(second.state.kind, 'succeeded');
    assert.deepEqual(edits.draft?.addedIds, ['branch-cockpit', 'branch-tank']);
    assert.equal(edits.draft?.axialTailId, 'branch-tank');
    assert.equal(ship.assembly.graph.find(edge => edge.childId === 'branch-tank')?.parentId, 'branch-cockpit');
    assert.equal(ship.motion.mass, ship.assembly.totalMass);

    edits.removeLast();
    assert.equal(ship.assembly.module('branch-tank'), null);
    assert.deepEqual(edits.draft?.addedIds, ['branch-cockpit']);
    assert.equal(edits.draft?.axialTailId, 'branch-cockpit');
    assert.equal(ship.motion.mass, ship.assembly.totalMass);
    edits.finish();
    assert.deepEqual(edits.draft, null);
    assert.equal(ship.docks.status(ship.assembly, 'dock-left'), 'connected');
    assert.ok(ship.assembly.module('branch-cockpit') !== null);
  });

  test('ship construction: 予約を再開しても枝を保ち、破棄は追加した部品に限定する', () => {
    const ship = new ConstructionTestShip();
    const originalIds = ship.assembly.moduleIds;
    const edits = new ShipConstructionEdits(ship, 'dock-left');
    edits.begin();
    edits.place('cockpit-standard', 'axial', 'branch-cockpit');
    edits.place('tank-3-main', 'axial', 'branch-tank');
    const resumed = new ShipConstructionEdits(ship, 'dock-left');
    resumed.begin();
    assert.deepEqual(resumed.draft, edits.draft);
    resumed.discard();
    assert.equal(resumed.draft, null);
    assert.deepEqual(ship.assembly.moduleIds, originalIds);
    assert.equal(ship.docks.status(ship.assembly, 'dock-left'), 'empty');
    assert.equal(ship.motion.mass, ship.assembly.totalMass);
  });

  test('ship construction: 適用前に候補が消えた配置命令は構成を変更しない', () => {
    const ship = new ConstructionTestShip();
    const edits = new ShipConstructionEdits(ship, 'dock-left');
    edits.begin();
    edits.place('cockpit-standard', 'axial', 'branch-cockpit');
    const queue = new CommandQueue();
    const completion = new CommandCompletion();
    queue.submitWithCompletion(() => edits.place('radiator-standard', 'branch-cockpit:side+y', 'radiator'), completion);
    edits.removeLast();
    const originalIds = ship.assembly.moduleIds;
    queue.applyAll();
    assert.equal(completion.state.kind, 'failed');
    assert.deepEqual(ship.assembly.moduleIds, originalIds);
    assert.deepEqual(edits.draft?.addedIds, []);
  });

  test('ship construction: 破壊済みドックへの配置を適用時に拒否する', () => {
    const ship = new ConstructionTestShip();
    const edits = new ShipConstructionEdits(ship, 'dock-left');
    edits.begin();
    const queue = new CommandQueue();
    const completion = new CommandCompletion();
    queue.submitWithCompletion(() => edits.place('cockpit-standard', 'axial', 'branch-cockpit'), completion);
    ship.assembly.setHp('dock-left', 0);
    queue.applyAll();
    assert.equal(completion.state.kind, 'failed');
    assert.equal(ship.assembly.module('branch-cockpit'), null);
    assert.deepEqual(edits.draft?.addedIds, []);
  });

}
