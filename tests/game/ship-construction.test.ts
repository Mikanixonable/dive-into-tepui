import * as assert from 'node:assert/strict';
import { ShipAssembly } from '../../src/game/ship/ship-assembly';
import { ShipDockState } from '../../src/game/ship/ship-dock-state';
import { createBasePreset } from '../../src/game/ship/ship-presets';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import { createShipModuleInstance } from '../../src/game/ship/ship-module-instance';
import { enumerateConstructionSlots, placementForSlot } from '../../src/game/ship/ship-construction-rules';
import { restoreConstructionDrafts, restoreDockedVessels } from '../../src/game/ship/ship-save';
import { test } from '../harness';
import { constructionCandidate, hitsConstructionCandidate } from '../../src/game/ship/ship-construction-candidates';
import { LOCAL_FORWARD, LOCAL_UP, Q_IDENTITY, qFromAxisAngle, qRotate } from '../../src/math/quat';
import { add, sub, scale, len, v3 } from '../../src/math/vec3';

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
}
