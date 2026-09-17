import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { Q_IDENTITY } from '../../src/math/quat';
import { v3 } from '../../src/math/vec3';
import { kinematicState } from '../../src/physics/kinematic-state';
import { FlashEffects } from '../../src/game/vfx/flash-effects';
import { ModularShip } from '../../src/game/ship/modular-ship';
import { ShipAssembly } from '../../src/game/ship/ship-assembly';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import { createShipModuleInstance } from '../../src/game/ship/ship-module-instance';
import type { MarkerSlots } from '../../src/game/marker/marker-slots';
import type { Notifier } from '../../src/hud/notifier';
import type { WorldSfx } from '../../src/audio/sfx/world-sfx';

function installCanvasStub(): void {
  const context = {
    createRadialGradient: () => ({ addColorStop() {} }), fillStyle: '' as unknown, fillRect() {},
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  };
  (globalThis as unknown as Record<string, unknown>).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => context }),
  };
}

function runtime(assembly: ShipAssembly, id = 'loss-test'): ModularShip {
  installCanvasStub();
  const notifier: Notifier = { hint() {}, toast() {} };
  const markers = {
    shows: () => false, set() {}, setPosition() {}, setDirection() {}, setNodePosition() {}, setBearing() {},
    hide() {}, fadeOut() {}, remove() {},
  } as MarkerSlots;
  return new ModularShip(
    notifier, { decouple() {} } as WorldSfx, new THREE.Scene(), new FlashEffects(), markers,
    {
      id, name: id, assembly,
      state: kinematicState<'eci'>(3, v3(7_000_000, 0, 0), v3()),
      att: { q: Q_IDENTITY, w: v3(), inertia: v3(1, 1, 1) },
    },
  );
}

function single(definitionId: string, moduleId: string): ShipAssembly {
  const assembly = new ShipAssembly(SHIP_MODULE_CATALOG, true);
  assembly.addRoot(createShipModuleInstance(SHIP_MODULE_CATALOG.require(definitionId), moduleId));
  return assembly;
}

export function register(): void {
  test('ship loss persistence: cockpit全損は同じ生存entityの物資として保存する', () => {
    const original = runtime(single('cockpit-standard', 'cockpit'));
    original.assembly.setHp('cockpit', 0);
    original.synchronizeAssemblyState();
    assert.equal(original.motion.alive, true);
    assert.equal(original.capabilities.role, 'material');
    const saved = original.serialize();
    assert.ok(saved);
    installCanvasStub();
    const copy = new ModularShip(
      { hint() {}, toast() {} }, { decouple() {} } as WorldSfx,
      new THREE.Scene(), new FlashEffects(), {
        shows: () => false, set() {}, setPosition() {}, setDirection() {}, setNodePosition() {}, setBearing() {},
        hide() {}, fadeOut() {}, remove() {},
      } as MarkerSlots,
      { saved, simTime: 3 },
    );
    assert.equal(copy.id, original.id);
    assert.equal(copy.assembly.module('cockpit')?.hp, 0);
    assert.equal(copy.capabilities.role, 'material');
    original.dispose();
    copy.dispose();
  });

  test('ship loss persistence: tankだけ・燃料0でも漂流物資として生存する', () => {
    const assembly = single('tank-3-main', 'tank');
    assembly.consumeFuel('main', Number.MAX_VALUE);
    const material = runtime(assembly);
    material.synchronizeAssemblyState();
    assert.equal(material.capabilities.role, 'material');
    assert.equal(material.totalFuel, 0);
    assert.equal(material.motion.alive, true);
    assert.ok(material.serialize());
    material.dispose();
  });

  test('ship loss persistence: 最後のmodule instance喪失だけがentityを失わせる', () => {
    const assembly = single('tank-3-main', 'tank');
    const material = runtime(assembly);
    assembly.removeModule('tank');
    material.synchronizeAssemblyState();
    assert.equal(material.motion.alive, false);
    assert.equal(material.serialize(), null);
    material.dispose();
  });

  test('ship loss persistence: docking中は一つのassemblyと保存単位になる', () => {
    const host = single('dock-standard', 'host-dock');
    const guest = single('docking-port-standard', 'guest-port');
    const merged = host.mergedAtDock(guest, 'host-dock', 'guest-port', 'guest').assembly;
    const combined = runtime(merged);
    const saved = combined.serialize();
    assert.ok(saved);
    assert.equal(saved.assembly.modules.length, 2);
    assert.equal(saved.assembly.connections.filter(edge => edge.kind === 'docking').length, 1);
    combined.dispose();
  });
}
