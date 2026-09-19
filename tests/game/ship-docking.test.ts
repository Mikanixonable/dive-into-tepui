import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { LOCAL_RIGHT, qFromAxisAngle, qMul, qRotate, Q_IDENTITY, type Quat } from '../../src/math/quat';
import { add, v3, type Vec3 } from '../../src/math/vec3';
import { kinematicState } from '../../src/physics/kinematic-state';
import { ShipAssembly } from '../../src/game/ship/ship-assembly';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import { createShipModuleInstance } from '../../src/game/ship/ship-module-instance';
import { shipPhysicsShape } from '../../src/game/ship/ship-physics-shape';
import {
  DOCKING_MAX_ANGLE, DOCKING_MAX_DISTANCE, DOCKING_MAX_RELATIVE_SPEED, dockingEligibility,
} from '../../src/game/ship/ship-docking';
import { ModularShip } from '../../src/game/ship/modular-ship';
import { FlashEffects } from '../../src/game/vfx/flash-effects';
import type { MarkerSlots } from '../../src/game/marker/marker-slots';
import type { Notifier } from '../../src/hud/notifier';
import type { WorldSfx } from '../../src/audio/sfx/world-sfx';
import type { ControlSelection } from '../../src/game/control-selection';
import type { DynamicEntity } from '../../src/game/dynamic/dynamic-entity/dynamic-entity';
import { ShipDockState } from '../../src/game/ship/ship-dock-state';
import { createBasePreset } from '../../src/game/ship/ship-presets';

function dockingAssembly(portKind: 'dock' | 'docking_port' = 'dock'): ShipAssembly {
  const assembly = new ShipAssembly(SHIP_MODULE_CATALOG, true);
  assembly.addRoot(createShipModuleInstance(SHIP_MODULE_CATALOG.require('cockpit-standard'), 'cockpit'));
  const definition = portKind === 'dock' ? 'dock-standard' : 'docking-port-standard';
  assembly.append(createShipModuleInstance(SHIP_MODULE_CATALOG.require(definition), 'port'));
  return assembly;
}

function fakeShip(q: Quat, root: Vec3, velocity = v3(), portKind: 'dock' | 'docking_port' = 'dock'): ModularShip {
  const assembly = dockingAssembly(portKind);
  const shape = shipPhysicsShape(assembly);
  assert.ok(shape !== null);
  const state = kinematicState<'eci'>(0, add(root, qRotate(q, shape.centerOffset)), velocity);
  return {
    assembly,
    motion: { state, att: { q, w: v3(), inertia: shape.mass.inertia }, centerOffset: shape.centerOffset },
    capabilities: {
      modules(kind: string, healthyOnly = false) {
        return assembly.modules.filter(module => module.kind === kind && (!healthyOnly || module.hp > 0));
      },
    },
  } as unknown as ModularShip;
}

function installCanvasStub(): void {
  const context = {
    createRadialGradient: () => ({ addColorStop() {} }), fillStyle: '' as unknown, fillRect() {},
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  };
  (globalThis as unknown as Record<string, unknown>).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => context }),
  };
}

function realShip(id: string, q: Quat, root: Vec3, portKind: 'dock' | 'docking_port'): ModularShip {
  installCanvasStub();
  const assembly = dockingAssembly(portKind);
  const shape = shipPhysicsShape(assembly);
  assert.ok(shape !== null);
  const notifier: Notifier = { hint() {}, toast() {} };
  const markers = {
    shows: () => false, set() {}, setPosition() {}, setDirection() {}, setNodePosition() {}, setBearing() {},
    hide() {}, fadeOut() {}, remove() {},
  } as MarkerSlots;
  return new ModularShip(
    notifier, { decouple() {} } as WorldSfx, new THREE.Scene(), new FlashEffects(), markers,
    {
      id, name: id, assembly,
      state: kinematicState<'eci'>(10, add(root, qRotate(q, shape.centerOffset)), v3()),
      att: { q, w: v3(), inertia: shape.mass.inertia },
    },
  );
}

function pair(
  distance: number, angle: number, relativeSpeed: number,
  kinds: readonly ['dock' | 'docking_port', 'dock' | 'docking_port'] = ['dock', 'docking_port'],
) {
  const first = fakeShip(Q_IDENTITY, v3(), v3(), kinds[0]);
  const facingBack = qFromAxisAngle(LOCAL_RIGHT, Math.PI);
  const tilted = qMul(qFromAxisAngle(v3(0, 1, 0), angle), facingBack);
  const second = fakeShip(tilted, v3(distance, 0, 5), v3(relativeSpeed, 0, 0), kinds[1]);
  return dockingEligibility(first, 'port', second, 'port');
}

export function register(): void {
  test('ship docking: 距離・角度・相対速度の境界値を受け入れ、直外を拒否する', () => {
    assert.equal(pair(DOCKING_MAX_DISTANCE, 0, 0).eligible, true);
    assert.equal(pair(DOCKING_MAX_DISTANCE + 1e-6, 0, 0).eligible, false);
    assert.equal(pair(0, DOCKING_MAX_ANGLE, 0).eligible, true);
    assert.equal(pair(0, DOCKING_MAX_ANGLE + 1e-6, 0).eligible, false);
    assert.equal(pair(0, 0, DOCKING_MAX_RELATIVE_SPEED).eligible, true);
    assert.equal(pair(0, 0, DOCKING_MAX_RELATIVE_SPEED + 1e-6).eligible, false);
  });

  test('ship docking: dock と docking_port の全組み合わせを受け入れる', () => {
    for (const first of ['dock', 'docking_port'] as const) {
      for (const second of ['dock', 'docking_port'] as const) {
        assert.equal(pair(0, 0, 0, [first, second]).eligible, true, `${first}-${second}`);
      }
    }
  });

  test('ship docking: 4個の接舷部は building/connected を上書きせず独立管理する', () => {
    const base = createBasePreset();
    const states = new ShipDockState();
    states.beginBuilding(base, 'dock-left');
    assert.equal(states.status(base, 'dock-left'), 'building');
    assert.equal(states.status(base, 'dock-right'), 'empty');
    states.finishBuilding('dock-left');
    const first = dockingAssembly('docking_port');
    const mergedOnce = base.mergedAtDock(first, 'dock-left', 'port', 'first').assembly;
    const second = dockingAssembly('dock');
    const mergedTwice = mergedOnce.mergedAtDock(second, 'dock-right', 'port', 'second').assembly;
    assert.equal(states.status(mergedTwice, 'dock-left'), 'connected');
    assert.equal(states.status(mergedTwice, 'dock-right'), 'connected');
    assert.equal(mergedTwice.dockingConnections().length, 2);
    assert.equal(mergedTwice.validate().valid, true);
  });

  test('ship docking: 使用中 port と cockpit のない二物資を拒否する', () => {
    const first = fakeShip(Q_IDENTITY, v3());
    const second = fakeShip(qFromAxisAngle(LOCAL_RIGHT, Math.PI), v3(0, 0, 5));
    const merged = first.assembly.mergedAtDock(second.assembly, 'port', 'port', 'second');
    (first as unknown as { assembly: ShipAssembly }).assembly = merged.assembly;
    assert.equal(dockingEligibility(first, 'port', second, 'port').eligible, false);
    const materialA = fakeShip(Q_IDENTITY, v3());
    const materialB = fakeShip(qFromAxisAngle(LOCAL_RIGHT, Math.PI), v3(0, 0, 5));
    materialA.assembly.setHp('cockpit', 0);
    materialB.assembly.setHp('cockpit', 0);
    assert.equal(dockingEligibility(materialA, 'port', materialB, 'port').eligible, false);
  });

  test('ship docking: runtime entity を一体へ統合し、同じ docking edge から再発進する', () => {
    const host = realShip('host', Q_IDENTITY, v3(), 'dock');
    const guest = realShip('guest', qFromAxisAngle(LOCAL_RIGHT, Math.PI), v3(0, 0, 5), 'docking_port');
    let removed: ModularShip | null = null;
    const selection = {
      remove(ship: ModularShip) { removed = ship; ship.dispose(); },
    } as unknown as ControlSelection;
    const connectionId = host.dock(guest, 'port', 'port', selection);
    assert.equal(removed, guest);
    assert.equal(host.assembly.dockingConnections()[0]?.id, connectionId);
    assert.equal(host.assembly.isDockingPortOccupied('port'), true);
    assert.equal(host.assembly.validate().valid, true);
    assert.ok(host.assembly.module('guest:cockpit'));
    assert.equal(host.capabilities.operatingCockpitId, 'cockpit');
    host.assembly.setHp('cockpit', 0);
    host.capabilities.reconcileOperatingCockpit();
    assert.equal(host.capabilities.operatingCockpitId, 'guest:cockpit');
    const added: DynamicEntity[] = [];
    const relaunched = host.undock('port', {
      add(entity) { added.push(entity); },
      spawnWhenReady() { throw new Error('unexpected deferred spawn'); },
    });
    assert.deepEqual(added, [relaunched]);
    assert.equal(relaunched.id, 'guest');
    assert.ok(relaunched.assembly.module('guest:cockpit'));
    assert.equal(host.assembly.isDockingPortOccupied('port'), false);
    assert.equal(relaunched.assembly.isDockingPortOccupied('guest:port'), false);
    host.dispose();
    relaunched.dispose();
  });
}
