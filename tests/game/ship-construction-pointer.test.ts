// 建造のポインタ解釈の固定: 手持ち中のクリックは押した位置で候補を選び直して置き、
// 候補が無ければ何もしない。無効な候補の上でドラッグを離すと理由を出して手放す。
// 偽の入力・ホスト・カメラで ShipConstructionPointer を駆動する。
import * as assert from 'node:assert/strict';
import type { GrabbedDrag, Input, PointerPoint, PointerPress } from '../../src/input/input';
import type { Viewport } from '../../src/render/viewport';
import type { CameraSystem } from '../../src/game/camera/camera-system';
import type { Ray } from '../../src/math/ray';
import { screenProjection, type Viewpoint } from '../../src/math/projection';
import { add, scale, sub, v3, type Vec3 } from '../../src/math/vec3';
import { Q_IDENTITY, qRotate } from '../../src/math/quat';
import type { ShipAssembly } from '../../src/game/ship/ship-assembly';
import type { CompoundCylinderRayHit } from '../../src/physics/compound-cylinder-contact';
import { kinematicState } from '../../src/physics/kinematic-state';
import { CommandQueue } from '../../src/game/command-queue';
import {
  ShipConstruction, type ShipConstructionPanelPort,
} from '../../src/game/ship/ship-construction';
import { createBasePreset } from '../../src/game/ship/ship-presets';
import { ShipCapabilities } from '../../src/game/ship/ship-capabilities';
import { ModularShipMotion } from '../../src/game/ship/modular-ship-motion';
import {
  ShipConstructionPointer, type ConstructionPointerHost,
} from '../../src/game/ship/ship-construction-pointer';
import type { ConstructionShip } from '../../src/game/ship/ship-construction-edits';
import type { ConstructionTargetGuide } from '../../src/game/ship/ship-construction-candidates';
import { constructionTargetId } from '../../src/game/ship/ship-construction-rules';
import type { ConstructionTrial } from '../../src/game/ship/ship-construction-preview';
import type {
  ConstructionCardDrag, ConstructionHeld, ConstructionTarget,
} from '../../src/game/ship/ship-construction-types';
import type { ModularShip } from '../../src/game/ship/modular-ship';
import type { OverlayManager } from '../../src/hud/overlay-manager';
import type { Notifier } from '../../src/hud/notifier';
import type { DisplayWindowManager } from '../../src/game/display-window-manager';
import type { RunEventSink } from '../../src/game/run-events';
import { test } from '../harness';

// interpretPointer が使う面だけを持つ偽の入力。掴んだ押下はドラッグとして残し、
// クリックの消費はキューの先着順をまねる。
class FakeInput {
  public pointerPoint: PointerPoint | null = null;
  private readonly presses: PointerPress[] = [];
  private readonly clicks: PointerPoint[] = [];
  private readonly grabs = new Map<number, GrabbedDrag>();

  public press(id: number, point: PointerPoint): void {
    this.presses.push({ id, point });
  }

  public click(point: PointerPoint): void {
    this.clicks.push(point);
  }

  // 掴んだドラッグを動かす。released へ同じ位置を渡すと離したことになる。
  public moveGrab(id: number, point: PointerPoint, released: PointerPoint | null): void {
    const drag = this.grabs.get(id);
    if (drag !== undefined) this.grabs.set(id, { ...drag, point, released });
  }

  public takePresses(handler: (press: PointerPress) => boolean): void {
    for (const press of [...this.presses]) {
      if (!handler(press)) continue;
      this.presses.splice(this.presses.indexOf(press), 1);
      this.grabs.set(press.id, { id: press.id, start: press.point, point: press.point, released: null });
    }
  }

  public grabbedDrag(id: number): GrabbedDrag | null {
    return this.grabs.get(id) ?? null;
  }

  public canvasPoint(x: number, y: number): PointerPoint {
    return { x, y };
  }

  public takeClicks(handler: (point: PointerPoint) => boolean): void {
    for (const click of [...this.clicks]) {
      if (handler(click)) this.clicks.splice(this.clicks.indexOf(click), 1);
    }
  }

  public takeRightClicks(_handler: (point: PointerPoint) => boolean): void {}

  public down(): boolean {
    return false;
  }
}

// 呼び出しを記録する偽のホスト。候補・ポインタの下のモジュール・試し置きの結果は
// テストが差し込む。
class FakeHost implements ConstructionPointerHost {
  public hitModuleId: string | null = null;
  public held: ConstructionHeld | null = null;
  public selectedModuleId: string | null = null;
  public pointedTargetId: string | null = null;
  public cardDrag: ConstructionCardDrag | null = null;
  public guides: readonly ConstructionTargetGuide[] = [];
  public trial: ConstructionTrial | null = null;
  public readonly calls: string[] = [];

  public readonly sessionShip = {
    assembly: { graph: [] } as unknown as ShipAssembly,
    motion: {
      state: { r: v3() },
      raycastCompound: (_ray: Ray, _pos: Vec3): CompoundCylinderRayHit | null =>
        this.hitModuleId === null ? null
          : { point: v3(), normal: v3(), distance: 1, moduleId: this.hitModuleId },
    },
  };

  public targetGuides(): readonly ConstructionTargetGuide[] { return this.guides; }
  public pointedTrial(): ConstructionTrial | null { return this.trial; }
  public setPointedTarget(targetId: string | null): void {
    this.calls.push(`pointed:${targetId}`);
    this.pointedTargetId = targetId;
  }
  public placeAt(targetId?: string): void { this.calls.push(`place:${targetId}`); }
  public moveSelectedTo(targetId: string): void { this.calls.push(`move:${targetId}`); }
  public hold(held: ConstructionHeld): void { this.calls.push('hold'); this.held = held; }
  public release(): void { this.calls.push('release'); this.held = null; }
  public releaseWithReason(reason: string): void {
    this.calls.push(`release:${reason}`);
    this.held = null;
  }
  public select(moduleId: string | null): void {
    this.calls.push(`select:${moduleId}`);
    this.selectedModuleId = moduleId;
  }
  public hoveredModuleId: string | null = null;
  public setHoveredModule(moduleId: string | null): void {
    this.hoveredModuleId = moduleId;
  }
  public canEditModule(): boolean { return true; }
  public clearCardDrag(): void { this.calls.push('clearCardDrag'); this.cardDrag = null; }
  public rotate(): void {}
  public swapEnds(): void {}
  public cycleSymmetry(): void {}
  public duplicateSelected(): void {}
  public removeSelected(): void {}
  public undo(): void {}
  public redo(): void {}
  public focus(): void {}
  public selectCatalogCategory(): void {}
}

const VIEWPOINT: Viewpoint = {
  position: v3(0, 0, -100), lookTarget: v3(), up: v3(0, 1, 0), fovDeg: 60, aspect: 4 / 3,
};
const VIEWPORT: Viewport = { width: 800, height: 600, pixelRatio: 1 };

const CAMERA = {
  activeViewpoint: VIEWPOINT,
  rayThroughScreen: (): Ray => ({ origin: v3(), dir: v3(0, 0, 1) }),
} as unknown as CameraSystem;

function guide(target: ConstructionTarget, guideEci: Vec3): ConstructionTargetGuide {
  return {
    target, label: '', guideEci, normalEci: v3(0, 0, 1), guideRadius: 1,
    placement: { valid: true, reason: null, attachments: [], reattachment: null },
  };
}

// guideEci が映る画面位置。クリック・ドロップ位置をノードの半径内へ置くために使う。
function screenPoint(guideEci: Vec3): PointerPoint {
  const projected = screenProjection(VIEWPOINT, VIEWPORT.width, VIEWPORT.height)(guideEci);
  return { x: projected.x, y: projected.y };
}

// 実際の船体と命令列で ShipConstruction を動かすための、構造編集後に物性を同期する最小の船。
class PointerTestShip implements ConstructionShip {
  public readonly name = 'test';
  public readonly assembly = createBasePreset();
  public readonly capabilities = new ShipCapabilities(this.assembly);
  public readonly motion = new ModularShipMotion(
    this.assembly, kinematicState<'eci'>(0, v3(100, 200, 300), v3()),
    { q: Q_IDENTITY, w: v3(), inertia: v3(1, 1, 1) },
  );

  public synchronizeAssemblyState(): void {
    this.motion.synchronizeAssembly();
    this.capabilities.reconcileOperatingCockpit();
  }
}

export function register(): void {
  test('construction pointer: 手持ち中に候補の無い位置をクリックしても手放さず選ばない', () => {
    const host = new FakeHost();
    host.held = { kind: 'catalog', definitionId: 'tank-3-main' };
    host.guides = [guide({ kind: 'axial-face', parentId: 'm1', face: 'front' }, v3(0, 0, 0))];
    const input = new FakeInput();
    const pointer = new ShipConstructionPointer(host);
    // ガイドは画面中央へ映る。遠くをクリックしても、ポインタの下にモジュールも無い。
    input.pointerPoint = { x: 700, y: 500 };
    input.click({ x: 700, y: 500 });

    pointer.interpretPointer(input as unknown as Input, CAMERA, VIEWPORT);

    // 指し先の追従で候補を外すだけで、手放し・選択・配置は呼ばれない。
    assert.deepEqual(host.calls, ['pointed:null']);
  });

  test('construction pointer: クリックは押した位置で候補を選び直してから置く', () => {
    const host = new FakeHost();
    host.held = { kind: 'catalog', definitionId: 'tank-3-main' };
    const target: ConstructionTarget = { kind: 'axial-face', parentId: 'm1', face: 'front' };
    host.guides = [guide(target, v3(0, 0, 0))];
    const input = new FakeInput();
    const pointer = new ShipConstructionPointer(host);
    // ホバーは候補から離れた場所。クリックはガイドの真上。
    input.pointerPoint = { x: 0, y: 0 };
    input.click(screenPoint(v3(0, 0, 0)));

    pointer.interpretPointer(input as unknown as Input, CAMERA, VIEWPORT);

    const id = constructionTargetId(target);
    assert.deepEqual(host.calls, ['pointed:null', `pointed:${id}`, 'place:undefined']);
  });

  test('construction pointer: 無効な候補の上でドラッグを離すと理由を出して手放す', () => {
    const host = new FakeHost();
    host.selectedModuleId = 'm1';
    host.hitModuleId = 'm1'; // 選択中モジュールの上からの押下に見せる
    const target: ConstructionTarget = { kind: 'axial-face', parentId: 'm2', face: 'front' };
    host.guides = [guide(target, v3(0, 0, 0))];
    host.trial = {
      valid: false, reason: 'その取り付け面はふさがっています',
      placed: [], totals: null, healthyCockpitRemains: true, overlapModuleIds: [],
    };
    const input = new FakeInput();
    const pointer = new ShipConstructionPointer(host);
    // 選択中モジュールの上で押して先端部を掴む。
    input.press(1, { x: 10, y: 10 });
    pointer.interpretPointer(input as unknown as Input, CAMERA, VIEWPORT);
    assert.equal(host.held?.kind, 'piece');
    // 候補の上で離す。
    const drop = screenPoint(v3(0, 0, 0));
    input.moveGrab(1, drop, drop);
    pointer.interpretPointer(input as unknown as Input, CAMERA, VIEWPORT);

    const id = constructionTargetId(target);
    assert.deepEqual(host.calls, [
      'hold', 'pointed:null', `pointed:${id}`, `pointed:${id}`,
      'release:その取り付け面はふさがっています',
    ]);
  });

  test('construction pointer: 置くと手が空になり、同じ位置のクリックで置いたモジュールが選ばれる', () => {
    const ship = new PointerTestShip();
    const queue = new CommandQueue();
    const construction = new ShipConstruction(
      {} as unknown as Input,
      queue,
      {
        element: { contains: () => false },
        selectCatalogCategory: () => {},
        sync: () => {},
      } as unknown as ShipConstructionPanelPort,
      { openMode: () => {}, close: () => {}, isInputGated: () => false } as unknown as OverlayManager,
      { current: { forceCurrent: false }, setForceCurrent: () => {} } as unknown as DisplayWindowManager,
      { hint: () => {} } as unknown as Notifier,
      { request: () => {}, close: () => {} },
      { blueprints: [], canRecord: false },
      { record: () => {} } as unknown as RunEventSink,
    );
    construction.start(ship as unknown as ModularShip, 'dock-left');
    construction.hold({ kind: 'catalog', definitionId: 'tank-3-main' });

    // ドックの自由端のガイドが画面に映る視点から、その画面位置を押す。
    const guide = construction.targetGuides().find(
      entry => entry.target.kind === 'axial-face' && entry.target.parentId === 'dock-left'
        && entry.target.face === 'front',
    );
    assert.ok(guide !== undefined);
    const viewpoint: Viewpoint = {
      position: add(guide.guideEci, scale(guide.normalEci, 50)),
      lookTarget: guide.guideEci, up: v3(0, 1, 0), fovDeg: 60, aspect: 4 / 3,
    };
    // 置いたあとのクリックでモジュールを選ぶため、視線の照準を差し替えられる偽カメラ。
    let aim: Vec3 | null = null;
    const camera = {
      activeViewpoint: viewpoint,
      rayThroughScreen: (): Ray => aim === null
        ? { origin: v3(), dir: v3(0, 0, 1) }
        : { origin: add(aim, scale(guide.normalEci, 50)), dir: scale(guide.normalEci, -1) },
    } as unknown as CameraSystem;
    const point = screenProjection(viewpoint, VIEWPORT.width, VIEWPORT.height)(guide.guideEci);
    const input = new FakeInput();
    input.pointerPoint = { x: point.x, y: point.y };
    input.click({ x: point.x, y: point.y });

    construction.handlePointer(input as unknown as Input, camera, VIEWPORT);

    // 置きを受け付けた時点で手は空になる。船体への反映は命令の適用を待つ。
    assert.equal(construction.held, null);
    queue.applyAll();
    construction.sync();
    const placedId = construction.lastOperation?.moduleIds[0];
    assert.ok(placedId !== undefined);
    assert.ok(ship.assembly.module(placedId) !== null);

    // 次のフレームとして、置いたモジュールへ当たる視線で同じ位置をクリックする。
    aim = add(
      sub(ship.motion.state.r, qRotate(ship.motion.att.q, ship.motion.centerOffset)),
      qRotate(ship.motion.att.q, ship.assembly.worldTransformOf(placedId)!.position),
    );
    const next = new FakeInput();
    next.pointerPoint = { x: point.x, y: point.y };
    next.click({ x: point.x, y: point.y });

    construction.handlePointer(next as unknown as Input, camera, VIEWPORT);

    assert.equal(construction.selectedModuleId, placedId);
  });
}
