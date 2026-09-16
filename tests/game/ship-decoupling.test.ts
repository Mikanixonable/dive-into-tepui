import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { Q_IDENTITY } from '../../src/math/quat';
import { add, scale, v3 } from '../../src/math/vec3';
import { kinematicState } from '../../src/physics/kinematic-state';
import { FlashEffects } from '../../src/game/vfx/flash-effects';
import { ModularShip } from '../../src/game/ship/modular-ship';
import { ShipAssembly } from '../../src/game/ship/ship-assembly';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import { createShipModuleInstance } from '../../src/game/ship/ship-module-instance';
import {
  SHIP_DECOUPLING_COLLISION_GRACE, splitAtDecoupler,
} from '../../src/game/ship/ship-decoupling';
import type { MarkerSlots } from '../../src/game/marker/marker-slots';
import type { Notifier } from '../../src/hud/notifier';
import type { WorldSfx } from '../../src/audio/sfx/world-sfx';
import type { DynamicEntity } from '../../src/game/dynamic/dynamic-entity/dynamic-entity';

function module(definitionId: string, id: string) {
  return createShipModuleInstance(SHIP_MODULE_CATALOG.require(definitionId), id);
}

function separationAssembly(): ShipAssembly {
  const assembly = new ShipAssembly(SHIP_MODULE_CATALOG, true);
  assembly.addRoot(module('cockpit-standard', 'cockpit'));
  assembly.append(module('decoupler-standard', 'decoupler'));
  assembly.append(module('booster-standard', 'booster'));
  assembly.setIgnited('booster', true);
  return assembly;
}

function installCanvasStub(): void {
  const context = {
    createRadialGradient: () => ({ addColorStop: () => {} }),
    fillStyle: '' as unknown,
    fillRect: () => {},
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  };
  (globalThis as unknown as Record<string, unknown>).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => context }),
  };
}

function ship(assembly: ShipAssembly): ModularShip {
  installCanvasStub();
  const notifier: Notifier = { hint() {}, toast() {} };
  const markers = {
    shows: () => false,
    set() {}, setPosition() {}, setDirection() {}, setNodePosition() {}, setBearing() {},
    hide() {}, fadeOut() {}, remove() {},
  } as MarkerSlots;
  const worldSfx = { decouple() {} } as WorldSfx;
  return new ModularShip(
    notifier, worldSfx, new THREE.Scene(), new FlashEffects(), markers,
    {
      name: 'split-test', assembly,
      state: kinematicState<'eci'>(100, v3(1_000, 2_000, 3_000), v3(10, 20, 30)),
      att: { q: Q_IDENTITY, w: v3(), inertia: v3(1, 1, 1) },
    },
  );
}

function close(actual: number, expected: number, label: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} !== ${expected}`);
}

export function register(): void {
  test('ship decoupling: healthy decoupler の外側だけを排他的に分割する', () => {
    const source = separationAssembly();
    const split = splitAtDecoupler(source, 'decoupler');
    assert.deepEqual(split.retained.moduleIds, ['cockpit']);
    assert.deepEqual(split.detached.moduleIds, ['booster']);
    const booster = split.detached.module('booster');
    assert.ok(booster?.kind === 'booster');
    assert.equal(booster.ignited, true);
    assert.equal(source.size, 3, 'domain split must not consume the live assembly before commit');
    assert.throws(() => splitAtDecoupler(source, 'cockpit'), /not a decoupler/);
    source.setHp('decoupler', 0);
    assert.throws(() => splitAtDecoupler(source, 'decoupler'), /destroyed/);
  });

  test('ship decoupling: ModularShip 2隻へ移管し、運動量と衝突猶予を保つ', () => {
    const retained = ship(separationAssembly());
    const sourceId = retained.id;
    const beforeMass = retained.motion.mass;
    const beforeHp = retained.hp;
    const sourceBooster = retained.assembly.module('booster');
    assert.ok(sourceBooster?.kind === 'booster');
    const beforeFuel = sourceBooster.fuel;
    const consumedMass = SHIP_MODULE_CATALOG.require('decoupler-standard').dryMass;
    const beforeMomentum = scale(retained.motion.state.v, beforeMass - consumedMass);
    const added: DynamicEntity[] = [];
    const detached = retained.decouple('decoupler', {
      add(entity) { added.push(entity); },
      spawnWhenReady() { throw new Error('unexpected deferred spawn'); },
    });
    assert.equal(added[0], detached);
    assert.equal(added.length, 9, 'detached ship plus eight decoupler panels');
    assert.deepEqual(retained.assembly.moduleIds, ['cockpit']);
    assert.deepEqual(detached.assembly.moduleIds, ['booster']);
    assert.equal(retained.id, sourceId);
    assert.notEqual(detached.id, retained.id);
    assert.equal(detached.capabilities.role, 'material');
    assert.equal(retained.hp + detached.hp, beforeHp - SHIP_MODULE_CATALOG.require('decoupler-standard').maxHp);
    const detachedBooster = detached.assembly.module('booster');
    assert.ok(detachedBooster?.kind === 'booster');
    assert.equal(detachedBooster.fuel, beforeFuel);
    assert.equal(detachedBooster.ignited, true);
    const afterMomentum = add(
      scale(retained.motion.state.v, retained.motion.mass),
      scale(detached.motion.state.v, detached.motion.mass),
    );
    close(afterMomentum.x, beforeMomentum.x, 'momentum x');
    close(afterMomentum.y, beforeMomentum.y, 'momentum y');
    close(afterMomentum.z, beforeMomentum.z, 'momentum z');
    const boundary = retained.motion.state.t + SHIP_DECOUPLING_COLLISION_GRACE;
    assert.equal(retained.motion.contactsWith(detached.motion, boundary), false);
    assert.equal(detached.motion.contactsWith(retained.motion, boundary), false);
    assert.equal(retained.motion.contactsWith(detached.motion, boundary + 1e-9), true);
    assert.equal(detached.motion.contactsWith(retained.motion, boundary + 1e-9), true);
    retained.dispose();
    detached.dispose();
  });
}
