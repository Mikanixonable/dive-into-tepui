import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { ModularShip } from '../../src/game/ship/modular-ship';
import { FlashEffects } from '../../src/game/vfx/flash-effects';
import type { MarkerSlots } from '../../src/game/marker/marker-slots';
import type { Notifier } from '../../src/hud/notifier';
import type { WorldSfx } from '../../src/audio/sfx/world-sfx';
import { createBasePreset } from '../../src/game/ship/ship-presets';
import type { ShipAssembly } from '../../src/game/ship/ship-assembly';

function installCanvasStub(): void {
  const context = {
    createRadialGradient: () => ({ addColorStop: () => {} }),
    fillStyle: '' as unknown,
    fillRect: () => {},
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4),
    }),
  };
  (globalThis as unknown as Record<string, unknown>).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => context }),
  };
}

function ship(assembly?: ShipAssembly): ModularShip {
  installCanvasStub();
  const notifier: Notifier = { hint() {}, toast() {} };
  const markers = {
    shows: () => false,
    set() {}, setPosition() {}, setDirection() {}, setNodePosition() {}, setBearing() {},
    hide() {}, fadeOut() {}, remove() {},
  } as MarkerSlots;
  return new ModularShip(
    notifier,
    {} as WorldSfx,
    new THREE.Scene(),
    new FlashEffects(),
    markers,
    { name: 'modular-test', assembly },
  );
}

export function register(): void {
  test('modular ship control: base preset も共通 entity と有限物性を使う', () => {
    const base = ship(createBasePreset());
    assert.equal(base.capabilities.role, 'base');
    assert.equal(base.mapKind, 'base');
    assert.equal(base.inspection.listSection, 'base');
    assert.ok(Number.isFinite(base.motion.mass) && base.motion.mass > 0);
    assert.ok(Number.isFinite(base.hp) && base.hp > 0);
    assert.ok(Number.isFinite(base.totalFuel) && base.totalFuel > 0);
    assert.ok(base.motion.compoundShape !== null);
    base.dispose();
  });

  test('modular ship control: 既定 preset の戦闘能力と操作 cockpit を公開する', () => {
    const controlled = ship();
    assert.equal(controlled.capabilities.role, 'ship');
    assert.equal(controlled.capabilities.controllable, true);
    assert.equal(controlled.capabilities.operatingCockpitId, 'cockpit');
    assert.equal(controlled.totalThrust, 400_000);
    assert.equal(controlled.totalTorque, 2.24);
    assert.equal(controlled.totalFuel, 1_000);
    controlled.dispose();
  });

  test('modular ship control: main と RCS の燃料を相互代用しない', () => {
    const controlled = ship();
    const rcsBefore = controlled.capabilities.fuel('rcs');
    assert.equal(controlled.consumeFuel(10), 1);
    assert.equal(controlled.totalFuel, 990);
    assert.equal(controlled.capabilities.fuel('rcs'), rcsBefore);
    assert.equal(controlled.consumeRcsFuel(5), 1);
    assert.equal(controlled.totalFuel, 990);
    assert.equal(controlled.capabilities.fuel('rcs'), rcsBefore - 5);
    controlled.dispose();
  });

  test('modular ship control: cockpit 全損後も entity を残して操縦不能な物資にする', () => {
    const controlled = ship();
    controlled.assembly.setHp('cockpit', 0);
    controlled.capabilities.reconcileOperatingCockpit();
    assert.equal(controlled.capabilities.controllable, false);
    assert.equal(controlled.capabilities.role, 'material');
    assert.equal(controlled.motion.alive, true);
    controlled.dispose();
  });

  test('modular ship control: inspection は module 展開状態を assembly へ反映する', () => {
    const controlled = ship();
    controlled.inspection.setModuleDeployment('radiator-left', true);
    const radiator = controlled.assembly.module('radiator-left');
    assert.ok(radiator?.kind === 'radiator');
    assert.equal(radiator.deployed, 1);
    controlled.inspection.setModuleDeployment('solar-left', false);
    const solar = controlled.assembly.module('solar-left');
    assert.ok(solar?.kind === 'solar_panel');
    assert.equal(solar.deployed, 0);
    controlled.dispose();
  });
}
