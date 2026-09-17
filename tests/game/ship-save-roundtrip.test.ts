import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { Q_IDENTITY } from '../../src/math/quat';
import { v3 } from '../../src/math/vec3';
import { kinematicState } from '../../src/physics/kinematic-state';
import { FlashEffects } from '../../src/game/vfx/flash-effects';
import { ModularShip } from '../../src/game/ship/modular-ship';
import { createBasePreset, createDefaultCombatPreset } from '../../src/game/ship/ship-presets';
import { ShipAssembly } from '../../src/game/ship/ship-assembly';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import { createShipModuleInstance } from '../../src/game/ship/ship-module-instance';
import { restoreShipAssembly, serializeShipAssembly } from '../../src/game/ship/ship-save';
import type { MarkerSlots } from '../../src/game/marker/marker-slots';
import type { Notifier } from '../../src/hud/notifier';
import type { WorldSfx } from '../../src/audio/sfx/world-sfx';
import type { ShipSaveData } from '../../src/game/save/save-data';
import type { DynamicEntity } from '../../src/game/dynamic/dynamic-entity/dynamic-entity';

function installCanvasStub(): void {
  const context = {
    createRadialGradient: () => ({ addColorStop() {} }), fillStyle: '' as unknown, fillRect() {},
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  };
  (globalThis as unknown as Record<string, unknown>).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => context }),
  };
}

const notifier: Notifier = { hint() {}, toast() {} };
const markers = {
  shows: () => false, set() {}, setPosition() {}, setDirection() {}, setNodePosition() {}, setBearing() {},
  hide() {}, fadeOut() {}, remove() {},
} as MarkerSlots;
const worldSfx = { decouple() {} } as WorldSfx;

function ship(id: string, assembly: ShipAssembly): ModularShip {
  installCanvasStub();
  return new ModularShip(
    notifier, worldSfx, new THREE.Scene(), new FlashEffects(), markers,
    {
      id, name: id, assembly,
      state: kinematicState<'eci'>(20, v3(7_000_000, 10, 20), v3(1, 2, 3)),
      att: { q: Q_IDENTITY, w: v3(0.01, 0.02, 0.03), inertia: v3(1, 1, 1) },
    },
  );
}

function restored(saved: ShipSaveData): ModularShip {
  installCanvasStub();
  return new ModularShip(
    notifier, worldSfx, new THREE.Scene(), new FlashEffects(), markers,
    { saved, simTime: 20 },
  );
}

function portAssembly(): ShipAssembly {
  const assembly = new ShipAssembly(SHIP_MODULE_CATALOG, true);
  assembly.addRoot(createShipModuleInstance(SHIP_MODULE_CATALOG.require('cockpit-standard'), 'guest-cockpit'));
  assembly.append(createShipModuleInstance(SHIP_MODULE_CATALOG.require('docking-port-standard'), 'guest-port'));
  return assembly;
}

export function register(): void {
  test('ship save: assembly validator は全 module state と docking graph を往復する', () => {
    const base = createBasePreset();
    base.setHp('cockpit', 123);
    base.setDeployment('solar-left', 0.25);
    base.setTemperature('main-tank', 444);
    base.consumeFuel('main', 37);
    const merged = base.mergedAtDock(portAssembly(), 'dock-left', 'guest-port', 'guest').assembly;
    const saved = serializeShipAssembly(merged);
    const copy = restoreShipAssembly(JSON.parse(JSON.stringify(saved)) as typeof saved);
    assert.deepEqual(serializeShipAssembly(copy), saved);
    assert.throws(
      () => restoreShipAssembly({ ...saved, connections: saved.connections.slice(1) }),
      /not a tree/,
    );
    assert.throws(
      () => restoreShipAssembly({
        ...saved,
        connections: saved.connections.map((connection, index) => (
          index === 0 ? { ...connection, kind: 'invalid' } : connection
        )),
      } as typeof saved),
      /invalid saved ship connection/,
    );
  });

  test('ship save: free と building の状態、操作cockpit、運動状態を復元する', () => {
    const original = ship('building-ship', createBasePreset());
    original.docks.beginBuilding(original.assembly, 'dock-left');
    original.assembly.append(
      createShipModuleInstance(SHIP_MODULE_CATALOG.require('tank-3-main'), 'draft-tank'),
      'dock-left',
    );
    const connectionId = original.assembly.graph.find(edge => edge.childId === 'draft-tank')?.id;
    assert.ok(connectionId);
    original.docks.updateConstructionDraft({
      dockId: 'dock-left', addedIds: ['draft-tank'], axialTailId: 'draft-tank', firstConnectionId: connectionId,
    });
    original.synchronizeAssemblyState();
    const saved = original.serialize();
    assert.ok(saved);
    const copy = restored(saved);
    assert.deepEqual(copy.motion.state.r, original.motion.state.r);
    assert.deepEqual(copy.motion.state.v, original.motion.state.v);
    assert.deepEqual(copy.assembly.module('draft-tank'), original.assembly.module('draft-tank'));
    assert.equal(copy.docks.status(copy.assembly, 'dock-left'), 'building');
    assert.deepEqual(copy.docks.constructionDraft('dock-left')?.addedIds, ['draft-tank']);
    assert.equal(copy.capabilities.operatingCockpitId, 'cockpit');
    original.dispose();
    copy.dispose();
  });

  test('ship save: docked vessel identity を保ち、復元後に元IDで再発進する', () => {
    const merged = createBasePreset().mergedAtDock(portAssembly(), 'dock-left', 'guest-port', 'guest');
    const original = ship('dock-host', merged.assembly);
    const baseSave = original.serialize();
    assert.ok(baseSave);
    const saved: ShipSaveData = {
      ...baseSave,
      dockedVessels: [{ connectionId: merged.connectionId, id: 'guest-id', name: 'Guest' }],
    };
    const copy = restored(saved);
    const added: DynamicEntity[] = [];
    const detached = copy.undock('dock-left', {
      add(entity) { added.push(entity); },
      spawnWhenReady() { throw new Error('unexpected deferred spawn'); },
    });
    assert.equal(detached.id, 'guest-id');
    assert.equal(detached.name, 'Guest');
    assert.deepEqual(added, [detached]);
    original.dispose();
    copy.dispose();
    detached.dispose();
  });

  test('ship save: 多段docking枝を分離しても内側の船体identityを移管する', () => {
    const first = createBasePreset().mergedAtDock(
      createBasePreset(), 'dock-left', 'dock-left', 'guest',
    );
    const nestedPort = first.moduleIds.get('dock-right');
    assert.ok(nestedPort);
    const second = first.assembly.mergedAtDock(portAssembly(), nestedPort, 'guest-port', 'nested');
    const original = ship('nested-host', second.assembly);
    const baseSave = original.serialize();
    assert.ok(baseSave);
    const copy = restored({
      ...baseSave,
      dockedVessels: [
        { connectionId: first.connectionId, id: 'guest-id', name: 'Guest' },
        { connectionId: second.connectionId, id: 'nested-id', name: 'Nested' },
      ],
    });
    const detached = copy.undock('dock-left', {
      add() {}, spawnWhenReady() { throw new Error('unexpected deferred spawn'); },
    });
    const detachedSave = detached.serialize();
    assert.ok(detachedSave);
    assert.deepEqual(detachedSave.dockedVessels, [
      { connectionId: second.connectionId, id: 'nested-id', name: 'Nested' },
    ]);
    original.dispose();
    copy.dispose();
    detached.dispose();
  });

  test('ship save: 分離直後の自己衝突猶予と燃料0の漂流船を復元する', () => {
    const assembly = new ShipAssembly(SHIP_MODULE_CATALOG, true);
    assembly.addRoot(createShipModuleInstance(SHIP_MODULE_CATALOG.require('cockpit-standard'), 'cockpit'));
    assembly.append(createShipModuleInstance(SHIP_MODULE_CATALOG.require('decoupler-standard'), 'decoupler'));
    assembly.append(createShipModuleInstance(
      SHIP_MODULE_CATALOG.require('tank-3-main'), 'empty-tank', { fuel: 0 },
    ));
    const first = ship('stranded-a', assembly);
    const entities: DynamicEntity[] = [];
    const second = first.decouple('decoupler', {
      add(entity) { entities.push(entity); },
      spawnWhenReady() { throw new Error('unexpected deferred spawn'); },
    });
    const aSaved = first.serialize();
    const bSaved = second.serialize();
    assert.ok(aSaved && bSaved);
    assert.deepEqual(aSaved.collisionGrace.map(record => record.otherId), [second.id]);
    assert.deepEqual(bSaved.collisionGrace.map(record => record.otherId), [first.id]);
    const aCopy = restored(aSaved);
    const bCopy = restored(bSaved);
    aCopy.restoreCollisionGrace([aCopy, bCopy]);
    bCopy.restoreCollisionGrace([aCopy, bCopy]);
    assert.equal(aCopy.totalFuel, 0);
    assert.equal(aCopy.motion.alive, true);
    assert.equal(aCopy.motion.contactsAllowedWith(bCopy.motion, 20), false);
    first.dispose();
    second.dispose();
    for (const entity of entities.slice(1)) entity.dispose();
    aCopy.dispose();
    bCopy.dispose();
  });

  test('ship save: 喪失済み entity は保存しない', () => {
    const lost = ship('lost', createDefaultCombatPreset());
    lost.motion.alive = false;
    assert.equal(lost.serialize(), null);
    lost.dispose();
  });
}
