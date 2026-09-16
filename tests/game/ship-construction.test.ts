import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { Q_IDENTITY } from '../../src/math/quat';
import { v3 } from '../../src/math/vec3';
import { kinematicState } from '../../src/physics/kinematic-state';
import { FlashEffects } from '../../src/game/vfx/flash-effects';
import { ModularShip } from '../../src/game/ship/modular-ship';
import { createBasePreset } from '../../src/game/ship/ship-presets';
import {
  ShipConstruction, type ShipConstructionPanelPort,
} from '../../src/game/ship/ship-construction';
import type {
  ConstructionMount, ShipConstructionPanelModel,
} from '../../src/game/hud/panels/ship-construction-panel';
import type { MarkerSlots } from '../../src/game/marker/marker-slots';
import type { Notifier } from '../../src/hud/notifier';
import type { WorldSfx } from '../../src/audio/sfx/world-sfx';
import type { OverlayManager } from '../../src/hud/overlay-manager';
import type { DisplayWindowManager } from '../../src/game/display-window-manager';
import type { EntityRegistry } from '../../src/game/dynamic/entity-registry';
import type { DynamicEntity } from '../../src/game/dynamic/dynamic-entity/dynamic-entity';

class FakePanel implements ShipConstructionPanelPort {
  public readonly element = { contains: () => false };
  public onSelectionChange: ((definitionId: string, mount: ConstructionMount) => void) | null = null;
  public onPlace: (() => void) | null = null;
  public onRemove: (() => void) | null = null;
  public onFinish: (() => void) | null = null;
  public onDiscard: (() => void) | null = null;
  public model: ShipConstructionPanelModel | null = null;
  public sync(model: ShipConstructionPanelModel): void { this.model = model; }
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

function baseShip(): ModularShip {
  installCanvasStub();
  const assembly = createBasePreset();
  const notifier: Notifier = { hint() {}, toast() {} };
  const markers = {
    shows: () => false, set() {}, setPosition() {}, setDirection() {}, setNodePosition() {}, setBearing() {},
    hide() {}, fadeOut() {}, remove() {},
  } as MarkerSlots;
  return new ModularShip(
    notifier, { decouple() {} } as WorldSfx, new THREE.Scene(), new FlashEffects(), markers,
    {
      id: 'construction-host', name: '建造基地', assembly,
      state: kinematicState<'eci'>(10, v3(7_000_000, 0, 0), v3()),
      att: { q: Q_IDENTITY, w: v3(), inertia: v3(1, 1, 1) },
    },
  );
}

function fixture(): {
  readonly ship: ModularShip;
  readonly panel: FakePanel;
  readonly construction: ShipConstruction;
  readonly added: DynamicEntity[];
  readonly display: { forceCurrent: boolean };
} {
  const ship = baseShip();
  const panel = new FakePanel();
  const added: DynamicEntity[] = [];
  const display = { forceCurrent: false };
  const overlays = { open() {}, close() {} } as unknown as OverlayManager;
  const registry = {
    add(entity: DynamicEntity) { added.push(entity); },
    spawnWhenReady() { throw new Error('unexpected deferred spawn'); },
  } as EntityRegistry;
  const notifier: Notifier = { hint() {}, toast() {} };
  const construction = new ShipConstruction(
    new THREE.Scene(), panel, overlays, display as DisplayWindowManager, registry, notifier,
  );
  return { ship, panel, construction, added, display };
}

function select(panel: FakePanel, definitionId: string, mount: ConstructionMount): void {
  panel.onSelectionChange?.(definitionId, mount);
}

export function register(): void {
  test('ship construction: 軸方向追加・末尾撤去と cockpit 側面4スロットを編集する', () => {
    const f = fixture();
    f.construction.start(f.ship, 'dock-left');
    assert.equal(f.display.forceCurrent, true);
    assert.equal(f.ship.docks.status(f.ship.assembly, 'dock-left'), 'building');
    f.panel.onPlace?.();
    assert.equal(f.panel.model?.moduleCount, 1);
    for (const mount of ['side+x', 'side-x', 'side+y', 'side-y'] as const) {
      select(f.panel, 'dock-standard', mount);
      f.panel.onPlace?.();
    }
    assert.equal(f.panel.model?.moduleCount, 5);
    select(f.panel, 'dock-standard', 'side+x');
    assert.equal(f.panel.model?.canPlace, false);
    f.panel.onPlace?.();
    assert.equal(f.panel.model?.moduleCount, 5);
    f.panel.onRemove?.();
    assert.equal(f.panel.model?.moduleCount, 4);
    f.construction.dispose();
    f.ship.dispose();
  });

  test('ship construction: cockpitなし完成を確認し、キャンセル後に物資として発進する', () => {
    const f = fixture();
    f.construction.start(f.ship, 'dock-left');
    select(f.panel, 'tank-3-main', 'axial');
    f.panel.onPlace?.();
    assert.equal(f.panel.model?.role, 'material');
    const previousConfirm = globalThis.confirm;
    let accepted = false;
    globalThis.confirm = () => accepted;
    try {
      f.panel.onFinish?.();
      assert.equal(f.construction.active, true);
      assert.equal(f.added.length, 0);
      accepted = true;
      f.panel.onFinish?.();
      assert.equal(f.construction.active, false);
      assert.equal(f.added.length, 1);
      assert.equal((f.added[0] as ModularShip).capabilities.role, 'material');
      assert.equal(f.ship.docks.status(f.ship.assembly, 'dock-left'), 'empty');
    } finally {
      globalThis.confirm = previousConfirm;
      f.construction.dispose();
      f.ship.dispose();
      for (const entity of f.added) entity.dispose();
    }
  });

  test('ship construction: ESC相当のcloseで未完成を保持し、再開後の破棄だけが除去する', () => {
    const f = fixture();
    f.construction.start(f.ship, 'dock-left');
    f.panel.onPlace?.();
    const sizeWithDraft = f.ship.assembly.size;
    f.construction.close();
    assert.equal(f.ship.assembly.size, sizeWithDraft);
    assert.equal(f.ship.docks.status(f.ship.assembly, 'dock-left'), 'building');
    f.construction.start(f.ship, 'dock-left');
    assert.equal(f.panel.model?.moduleCount, 1);
    const previousConfirm = globalThis.confirm;
    let accepted = false;
    globalThis.confirm = () => accepted;
    try {
      f.panel.onDiscard?.();
      assert.equal(f.ship.assembly.size, sizeWithDraft);
      accepted = true;
      f.panel.onDiscard?.();
      assert.equal(f.ship.assembly.size, sizeWithDraft - 1);
      assert.equal(f.ship.docks.status(f.ship.assembly, 'dock-left'), 'empty');
    } finally {
      globalThis.confirm = previousConfirm;
      f.construction.dispose();
      f.ship.dispose();
    }
  });
}
