// ドック起点の建造セッションと候補配置を管理し、船体・HUD・ゴーストへ同期する。
import type * as THREE from 'three/webgpu';
import { LOCAL_FORWARD, qFromUnitVectors, qMul, qRotate, Q_IDENTITY } from '../../math/quat';
import { add, dot, scale, sub, v3, type Vec3 } from '../../math/vec3';
import type { Ray } from '../../math/ray';
import type { CameraFrame } from '../../render/camera/camera-frame';
import { DockSnapGuideView } from '../../render/dynamic/ship/dock-snap-guide-view';
import { ShipGhostView } from '../../render/dynamic/ship/ship-ghost-view';
import type { OverlayHandle, OverlayManager } from '../../hud/overlay-manager';
import type { Input } from '../../input/input';
import type { Viewport } from '../../render/viewport';
import type { CameraSystem } from '../camera/camera-system';
import type { DisplayWindowManager } from '../display-window-manager';
import type { EntityRegistry } from '../dynamic/entity-registry';
import type {
  ConstructionMount, ShipConstructionPanelModel,
} from '../hud/panels/ship-construction-panel';
import type { Notifier } from '../../hud/notifier';
import type { ModuleTransform } from './ship-assembly';
import { SHIP_MODULE_CATALOG } from './ship-module-catalog';
import { createShipModuleInstance } from './ship-module-instance';
import type { ModularShip } from './modular-ship';

const SIDE_DIRECTIONS: Record<Exclude<ConstructionMount, 'axial'>, Vec3> = {
  'side+x': v3(1, 0, 0), 'side-x': v3(-1, 0, 0),
  'side+y': v3(0, 1, 0), 'side-y': v3(0, -1, 0),
};
const SIDE_KINDS = new Set(['dock', 'docking_port', 'solar_panel', 'radiator']);

interface ConstructionDraft {
  readonly ship: ModularShip;
  readonly dockId: string;
  readonly addedIds: string[];
  axialTailId: string;
  firstConnectionId: string | null;
}

interface ConstructionCandidate {
  readonly valid: boolean;
  readonly reason: string | null;
  readonly parentId: string;
  readonly transform: ModuleTransform;
  readonly kind: 'axial' | 'side';
  readonly centerEci: Vec3;
  readonly rotationEci: ModuleTransform['rotation'];
  readonly guideEci: Vec3;
  readonly guideRadius: number;
}

let nextConstructionModule = 1;

export interface ShipConstructionPanelPort {
  readonly element: { contains(target: Node): boolean };
  onSelectionChange: ((definitionId: string, mount: ConstructionMount) => void) | null;
  onPlace: (() => void) | null;
  onRemove: (() => void) | null;
  onFinish: (() => void) | null;
  onDiscard: (() => void) | null;
  sync(model: ShipConstructionPanelModel): void;
}

// 一度に一つの建造セッションを所有し、論理 assembly・HUD・ghost を同じ候補へ同期する。
export class ShipConstruction implements OverlayHandle {
  private readonly ghost: ShipGhostView;
  private readonly guide: DockSnapGuideView;
  private readonly drafts = new Map<string, ConstructionDraft>();
  private current: ConstructionDraft | null = null;
  private definitionId = 'cockpit-standard';
  private mount: ConstructionMount = 'axial';
  private previousForceCurrent = false;

  public constructor(
    scene: THREE.Scene,
    private readonly panel: ShipConstructionPanelPort,
    private readonly overlayManager: OverlayManager,
    private readonly displayWindow: DisplayWindowManager,
    private readonly registry: EntityRegistry,
    private readonly notifier: Notifier,
    private readonly focusDock: ((ship: ModularShip) => void) | null = null,
  ) {
    this.ghost = new ShipGhostView(scene);
    this.guide = new DockSnapGuideView(scene);
    panel.onSelectionChange = (definitionId, mount) => {
      this.definitionId = definitionId;
      this.mount = mount;
    };
    panel.onPlace = () => this.place();
    panel.onRemove = () => this.removeLast();
    panel.onFinish = () => this.finish();
    panel.onDiscard = () => this.discard();
  }

  public get active(): boolean { return this.current !== null; }

  public start(ship: ModularShip, dockId: string): void {
    const module = ship.assembly.module(dockId);
    if (module?.kind !== 'dock') {
      throw new Error(`not a construction dock: ${dockId}`);
    }
    if (!ship.capabilities.controllable) throw new Error('健全なコックピットから操作できる船体が必要です');
    if (module.hp <= 0 || ship.assembly.isDockingPortOccupied(dockId)) throw new Error('空いている健全な接舷部が必要です');
    if (this.current !== null) this.close();
    const key = this.key(ship, dockId);
    let draft = this.drafts.get(key);
    if (draft === undefined) {
      let saved = ship.docks.constructionDraft(dockId);
      if (saved === null) {
        ship.docks.beginBuilding(ship.assembly, dockId);
        saved = ship.docks.constructionDraft(dockId);
      }
      if (saved === null) throw new Error(`construction draft missing: ${dockId}`);
      draft = {
        ship, dockId, addedIds: [...saved.addedIds],
        axialTailId: saved.axialTailId, firstConnectionId: saved.firstConnectionId,
      };
      this.drafts.set(key, draft);
    }
    this.current = draft;
    this.focusDock?.(ship);
    this.previousForceCurrent = this.displayWindow.current.forceCurrent;
    this.displayWindow.setForceCurrent(true);
    this.overlayManager.open('ship-construction-mode', this, {
      kind: 'window', closeOnEscape: true, closeOnOutsideClick: false, gatesInput: false,
    });
    this.syncPanel();
  }

  public contains(target: Node): boolean { return this.panel.element.contains(target); }

  // ESC では未完成枝を保持してセッションだけ閉じる。
  public close(): void {
    if (this.current === null) return;
    this.current = null;
    this.overlayManager.close('ship-construction-mode');
    this.displayWindow.setForceCurrent(this.previousForceCurrent);
    this.panel.sync({
      visible: false, moduleCount: 0, totalMass: 0, hp: 0, maxHp: 0,
      capabilitySummary: '—', role: 'material', warning: null,
      canPlace: false, canRemove: false, canFinish: false,
    });
    this.ghost.sync(null);
    this.guide.sync(null);
  }

  public handlePointer(input: Input, camera: CameraSystem, viewport: Viewport): boolean {
    if (this.current === null) return false;
    input.takeClicks((point) => {
      const ray = camera.rayThroughScreen(point.x, point.y, viewport);
      if (this.hitsCandidate(ray)) this.place();
      return true;
    });
    input.takeRightClicks(() => true);
    return true;
  }

  public sync(camera: CameraFrame): void {
    const candidate = this.candidate();
    if (this.current === null || candidate === null) {
      this.ghost.sync(null);
      this.guide.sync(null);
      return;
    }
    this.ghost.sync({
      modelId: SHIP_MODULE_CATALOG.require(this.definitionId).modelId,
      position: this.displayPosition(camera, candidate.centerEci),
      rotation: candidate.rotationEci,
      valid: candidate.valid,
    });
    this.guide.sync({
      position: this.displayPosition(camera, candidate.guideEci),
      rotation: candidate.rotationEci,
      radius: candidate.guideRadius,
      valid: candidate.valid,
    });
    this.syncPanel();
  }

  public dispose(): void {
    this.close();
    this.ghost.dispose();
    this.guide.dispose();
    this.panel.onSelectionChange = null;
    this.panel.onPlace = null;
    this.panel.onRemove = null;
    this.panel.onFinish = null;
    this.panel.onDiscard = null;
  }

  private place(): void {
    const draft = this.current;
    const candidate = this.candidate();
    if (draft === null || candidate === null || !candidate.valid) {
      if (candidate?.reason) this.notifier.hint(candidate.reason);
      return;
    }
    let id: string;
    do id = `construction-${nextConstructionModule++}`;
    while (draft.ship.assembly.module(id) !== null);
    draft.ship.assembly.addModule(
      createShipModuleInstance(SHIP_MODULE_CATALOG.require(this.definitionId), id),
      candidate.parentId, candidate.transform, candidate.kind,
    );
    const connection = draft.ship.assembly.graph.find(edge => edge.childId === id);
    if (connection === undefined) throw new Error(`construction connection missing: ${id}`);
    if (draft.firstConnectionId === null) draft.firstConnectionId = connection.id;
    draft.addedIds.push(id);
    if (candidate.kind === 'axial') draft.axialTailId = id;
    this.persistDraft(draft);
    this.synchronizeShip(draft.ship);
    this.syncPanel();
  }

  private removeLast(): void {
    const draft = this.current;
    const id = draft?.addedIds.at(-1);
    if (draft === null || id === undefined) return;
    draft.ship.assembly.removeModule(id);
    draft.addedIds.pop();
    const axial = [...draft.addedIds].reverse().find(moduleId => {
      const edge = draft.ship.assembly.graph.find(connection => connection.childId === moduleId);
      return edge?.kind === 'axial';
    });
    draft.axialTailId = axial ?? draft.dockId;
    draft.firstConnectionId = draft.addedIds.length === 0
      ? null
      : draft.ship.assembly.graph.find(edge => edge.childId === draft.addedIds[0])?.id ?? null;
    this.persistDraft(draft);
    this.synchronizeShip(draft.ship);
    this.syncPanel();
  }

  private finish(): void {
    const draft = this.current;
    if (draft === null || draft.firstConnectionId === null) return;
    const branch = draft.ship.assembly.clone().splitAt(draft.firstConnectionId)[1];
    if (branch.role === 'material'
      && typeof globalThis.confirm === 'function'
      && !globalThis.confirm('コックピットがないため操縦不能な物資として発進します。続けますか？')) return;
    draft.ship.launchConstruction(draft.firstConnectionId, this.registry);
    draft.ship.docks.finishBuilding(draft.dockId);
    this.drafts.delete(this.key(draft.ship, draft.dockId));
    this.close();
  }

  private discard(): void {
    const draft = this.current;
    if (draft === null) return;
    if (draft.addedIds.length > 0 && typeof globalThis.confirm === 'function'
      && !globalThis.confirm('建造中の部品をすべて破棄しますか？')) return;
    for (const id of [...draft.addedIds].reverse()) draft.ship.assembly.removeModule(id);
    draft.ship.docks.finishBuilding(draft.dockId);
    this.drafts.delete(this.key(draft.ship, draft.dockId));
    this.synchronizeShip(draft.ship);
    this.close();
  }

  private candidate(): ConstructionCandidate | null {
    const draft = this.current;
    if (draft === null) return null;
    const definition = SHIP_MODULE_CATALOG.require(this.definitionId);
    const parentId = draft.axialTailId;
    const parentDefinition = draft.ship.assembly.definition(parentId);
    const parentWorld = draft.ship.assembly.worldTransformOf(parentId);
    if (parentDefinition === null || parentWorld === null) return null;
    const side = this.mount !== 'axial';
    const direction = this.mount === 'axial' ? LOCAL_FORWARD : SIDE_DIRECTIONS[this.mount];
    const transform: ModuleTransform = side
      ? {
        position: scale(direction, parentDefinition.diameter / 2 + definition.length / 2),
        rotation: qFromUnitVectors(LOCAL_FORWARD, direction),
      }
      : {
        position: v3(0, 0, parentDefinition.length / 2 + definition.length / 2),
        rotation: Q_IDENTITY,
      };
    let reason: string | null = null;
    if (side && parentDefinition.kind !== 'cockpit' && parentDefinition.kind !== 'tank') {
      reason = '側面部品は cockpit または tank にだけ取り付けられます';
    } else if (side && !SIDE_KINDS.has(definition.kind)) {
      reason = '選択した部品は側面に取り付けられません';
    } else if (side && this.sideSlotOccupied(draft, parentId, direction)) {
      reason = '選択した側面スロットは使用中です';
    } else if (!side && (definition.kind === 'radiator' || definition.kind === 'solar_panel')) {
      reason = '選択した部品は側面スロット専用です';
    }
    const assemblyPosition = add(parentWorld.position, qRotate(parentWorld.rotation, transform.position));
    const assemblyRotation = qMul(parentWorld.rotation, transform.rotation);
    const root = sub(
      draft.ship.motion.state.r,
      qRotate(draft.ship.motion.att.q, draft.ship.motion.centerOffset),
    );
    const centerEci = add(root, qRotate(draft.ship.motion.att.q, assemblyPosition));
    const rotationEci = qMul(draft.ship.motion.att.q, assemblyRotation);
    const parentCenter = add(root, qRotate(draft.ship.motion.att.q, parentWorld.position));
    const guideDirection = qRotate(
      qMul(draft.ship.motion.att.q, parentWorld.rotation), direction,
    );
    const guideDistance = side ? parentDefinition.diameter / 2 : parentDefinition.length / 2;
    return {
      valid: reason === null, reason, parentId, transform, kind: side ? 'side' : 'axial',
      centerEci, rotationEci,
      guideEci: add(parentCenter, scale(guideDirection, guideDistance)),
      guideRadius: Math.min(parentDefinition.diameter, definition.diameter) / 2,
    };
  }

  private sideSlotOccupied(draft: ConstructionDraft, parentId: string, direction: Vec3): boolean {
    return draft.ship.assembly.graph.some(edge => edge.parentId === parentId && edge.kind === 'side'
      && dot(edge.childTransform.position, direction) > 0);
  }

  private hitsCandidate(ray: Ray): boolean {
    const candidate = this.candidate();
    if (candidate === null) return false;
    const normal = qRotate(candidate.rotationEci, LOCAL_FORWARD);
    const denominator = dot(ray.dir, normal);
    if (Math.abs(denominator) < 1e-9) return false;
    const distance = dot(sub(candidate.guideEci, ray.origin), normal) / denominator;
    if (distance < 0) return false;
    const hit = add(ray.origin, scale(ray.dir, distance));
    const offset = sub(hit, candidate.guideEci);
    const radialSq = dot(offset, offset) - dot(offset, normal) ** 2;
    return radialSq <= candidate.guideRadius ** 2;
  }

  private synchronizeShip(ship: ModularShip): void {
    ship.synchronizeAssemblyState();
  }

  private persistDraft(draft: ConstructionDraft): void {
    draft.ship.docks.updateConstructionDraft({
      dockId: draft.dockId,
      addedIds: draft.addedIds,
      axialTailId: draft.axialTailId,
      firstConnectionId: draft.firstConnectionId,
    });
  }

  private displayPosition(camera: CameraFrame, position: Vec3): Vec3 {
    const p = camera.floatingOrigin.RtoThreeV3(position);
    return v3(p.x, p.y, p.z);
  }

  private syncPanel(): void {
    const draft = this.current;
    const candidate = this.candidate();
    if (draft === null) return;
    const branch = draft.firstConnectionId === null
      ? null : draft.ship.assembly.clone().splitAt(draft.firstConnectionId)[1];
    const role = branch?.role ?? 'material';
    const totals = branch?.totals();
    const capabilitySummary = totals === undefined
      ? '—'
      : [
        `推力 ${Math.round(totals.thrust).toLocaleString()} N`,
        `主燃料 ${Math.round(totals.mainFuel).toLocaleString()}`,
        `RCS ${Math.round(totals.rcsFuel).toLocaleString()}`,
        `発電 ${Math.round(totals.power).toLocaleString()} W`,
        `放熱 ${Math.round(totals.radiation).toLocaleString()}`,
      ].join(' / ');
    this.panel.sync({
      visible: true,
      moduleCount: draft.addedIds.length,
      totalMass: branch?.totalMass ?? 0,
      hp: totals?.hp ?? 0,
      maxHp: totals?.maxHp ?? 0,
      capabilitySummary,
      role,
      warning: candidate?.reason ?? (role === 'material' && draft.addedIds.length > 0 ? '操縦不能な物資として完成します' : null),
      canPlace: candidate?.valid ?? false,
      canRemove: draft.addedIds.length > 0,
      canFinish: draft.firstConnectionId !== null,
    });
  }

  private key(ship: ModularShip, dockId: string): string { return `${ship.id}:${dockId}`; }
}
