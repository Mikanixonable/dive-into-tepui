// 建造中の表示導出。建造セッションの読み取り面から、接続ノードのマーカー宣言・
// スナップガイド・回転リング・ゴースト・モジュール強調の宣言と、操作音の種別を毎フレーム組む。
// 操作音は装置の語彙を持ち込まず、抽象的な種別の列として返す。
import { LOCAL_FORWARD, qFromUnitVectors, qMul, qRotate, type Quat } from '../../math/quat';
import { rayThroughScreen, type Projected, type ProjectFn } from '../../math/projection';
import type { Ray } from '../../math/ray';
import { add, len, scale, sub, v3, type Vec3 } from '../../math/vec3';
import { DockSnapGuideView, type DockSnapGuideDisplay } from '../../render/dynamic/ship/dock-snap-guide-view';
import { RotationRingView } from '../../render/dynamic/ship/rotation-ring-view';
import { ShipGhostView, type ShipGhostDisplay } from '../../render/dynamic/ship/ship-ghost-view';
import type { ShipModuleEmphasis, ShipModuleEmphasisMap } from '../../render/dynamic/ship/ship-render-contract';
import type { CameraFrame } from '../../render/camera/camera-frame';
import type { CompoundCylinderRayHit } from '../../physics/compound-cylinder-contact';
import type { MarkerDeclaration } from '../../marker/marker-declaration';
import type { MarkerDevice } from '../../marker/marker-device';
import type { MarkerSink } from '../../marker/marker-sink';
import { MARKER_PRIORITY } from '../marker/marker-priority';
import { pieceOfModule } from './ship-assembly-graft';
import type { ShipAssembly } from './ship-assembly';
import type { ConstructionTargetGuide } from './ship-construction-candidates';
import type { ConstructionTrial } from './ship-construction-preview';
import { constructionTargetId, heldRootDefinition, pieceRootId } from './ship-construction-rules';
import { orientationRotation, type ModuleOrientation } from './ship-assembly-transform';
import type {
  ConstructionDeniedRecord, ConstructionHeld, ConstructionOperationRecord,
} from './ship-construction-types';
import {
  constructionRotationRing, type ConstructionRotationDrag,
} from './ship-construction-rotation';
import { SHIP_MODULE_CATALOG } from './ship-module-catalog';
import type * as THREE from 'three/webgpu';

// 接続ノードの字形。取り付け位置は実体ではなく枠なので、中空の輪を使う。
const CONSTRUCTION_NODE_GLYPH = '◎';
// 接続ノードを出すマーカーの種別クラス。色は marker-identity-style のトークンが持つ。
const NODE_CLS = 'mk-construction-node';

// 差し込みの動きの距離と時間。SPEC/RENDERING.md「接続する方向から短い動きで差し込まれて現れる」。
export const INSERTION_OFFSET_DISTANCE_M = 2;
export const INSERTION_OFFSET_DURATION_MS = 250;

// 重なる相手の明滅の周期 [Hz]。SPEC/RENDERING.md「別の色で明滅する」。
const CONFLICT_BLINK_HZ = 2;

const SELECTED_INTENSITY = 1;
const HOVERED_INTENSITY = 0.5;
const PIECE_INTENSITY = 0.5;
const ZERO = v3();

// ノードは船体の表面に置かれるため、カメラからの線分は当たる面そのもので終わる。
// その面の当たりを遮蔽とみなさないよう、ノードより手前側へこの幅だけ余白を取る [m]。
const OCCLUSION_MARGIN_M = 0.3;

// 建造で鳴らす操作音の種別。装置の音名ではなく、建造側の語彙で表す。
export type ConstructionSound = 'snap' | 'place' | 'remove' | 'deny' | 'finish';

// 建造セッションの対象船体が持つ、表示導出が読む面。
export interface ConstructionViewShip {
  readonly id: string;
  readonly assembly: ShipAssembly;
  readonly motion: {
    readonly state: { readonly r: Vec3 };
    readonly att: { readonly q: Quat };
    assemblyToEci(local: Vec3): Vec3;
    raycastCompound(ray: Ray, pos: Vec3): CompoundCylinderRayHit | null;
  };
}

// 表示導出が読む建造セッションの面。読み取りと、選択メニューの追従位置を
// 書き込む口(syncSelectionMenu)を要求する。
export interface ShipConstructionViewSource {
  readonly sessionShip: ConstructionViewShip | null;
  readonly anchorId: string | null;
  readonly held: ConstructionHeld | null;
  readonly selectedModuleId: string | null;
  readonly pointedTargetId: string | null;
  // ポインタの下にあるモジュール。タッチ環境や船体の外では null。
  readonly hoveredModuleId: string | null;
  // 持ち運び中のドラッグの画面位置(キャンバス座標)。どちらのドラッグも無ければ null。
  readonly dragPoint: { readonly x: number; readonly y: number } | null;
  // 手持ちに対して効く向き(回転・端)。
  readonly heldOrientation: ModuleOrientation;
  // 回転リングを掴んだドラッグ中の角度。掴んでいなければ null。
  readonly rotationDrag: ConstructionRotationDrag | null;
  readonly lastOperation: ConstructionOperationRecord | null;
  readonly lastDenied: ConstructionDeniedRecord | null;
  // 全取り付け先の接続面ガイド(ECI 座標)。手持ち・選択中の部品への可否を評価済み。
  targetGuides(): readonly ConstructionTargetGuide[];
  pointedTrial(): ConstructionTrial | null;
  // 指している取り付け先の接続面ガイド(ECI 座標)。持つもの・指す先が無ければ null。
  pointedGuide(): ConstructionTargetGuide | null;
  // moduleId を根とする先端部が撤去・付け替え・回転を受け付けるか。
  canEditModule(moduleId: string): boolean;
  // 選択中モジュールの画面位置を選択メニューへ渡す口。選択が無い・読めないときは null。
  syncSelectionMenu(anchor: Projected | null): void;
}

// 1フレームの同期結果。shipModuleEmphasis はモジュール船の強調宣言、sounds は鳴らす
// 操作音の種別の列(発生順)。
export interface ConstructionViewSyncResult {
  readonly shipModuleEmphasis: ShipModuleEmphasisMap | null;
  readonly sounds: readonly ConstructionSound[];
}

// 手持ちの定義を引けない試し置きへ充てる表示モデルの定義 id。
const FALLBACK_HELD_MODEL_ID = 'cockpit-standard';

// 差し込みのずらしの大きさ [m]。経過 0 で 2 m ずれて現れ、easeOut で 0.25 秒に 0 へ収まる。
// 経過が負のときは始まっていないので最大ずらし、時間を過ぎたら 0。
export function insertionOffsetAt(elapsedMs: number): number {
  if (elapsedMs <= 0) return INSERTION_OFFSET_DISTANCE_M;
  if (elapsedMs >= INSERTION_OFFSET_DURATION_MS) return 0;
  const progress = elapsedMs / INSERTION_OFFSET_DURATION_MS;
  const remaining = (1 - progress) * (1 - progress) * (1 - progress);
  return INSERTION_OFFSET_DISTANCE_M * remaining;
}

// 明滅の強さ。nowMs から位相を取って 0..1 を往復する。
function conflictIntensityAt(nowMs: number): number {
  return 0.5 + 0.5 * Math.sin(nowMs * 2 * Math.PI * CONFLICT_BLINK_HZ / 1000);
}

// 物理の ECI 座標を、このフレームの floating origin 表示座標へ写す。
function displayPosition(camera: CameraFrame, position: Vec3): Vec3 {
  const p = camera.floatingOrigin.RtoThreeV3(position);
  return v3(p.x, p.y, p.z);
}

// 操作で動いた各モジュールが差し込まれる方向を、assembly 座標で返す。動いた集合を、両端が
// 集合の内側にある接続で成分に分け、成分と残りの船体を繋ぐ接続の「残り側 → 成分側」が
// 差し込み方向になる。継ぎ目への割り込みでは境界の接続が2本あるので、成分側が子側にある
// 接続(新しく作られた取り付け)を選ぶ。
function insertionDirections(
  assembly: ShipAssembly, movedIds: ReadonlySet<string>,
): Map<string, Vec3> {
  const graph = assembly.graph;
  // 動いた集合の内側の接続と、集合と残りの船体を繋ぐ境界の接続を分ける。
  const internal = graph.filter(
    edge => movedIds.has(edge.parentId) && movedIds.has(edge.childId));
  const boundary = graph.filter(
    edge => movedIds.has(edge.parentId) !== movedIds.has(edge.childId));
  // 内側の接続で連結した成分ごとに、差し込み方向を求める。
  const directions = new Map<string, Vec3>();
  const unvisited = new Set(movedIds);
  while (unvisited.size > 0) {
    const seed = unvisited.values().next().value!;
    const component = new Set([seed]);
    unvisited.delete(seed);
    const pending = [seed];
    while (pending.length > 0) {
      const current = pending.pop()!;
      for (const edge of internal) {
        const neighbor = edge.parentId === current ? edge.childId
          : edge.childId === current ? edge.parentId : null;
        if (neighbor !== null && !component.has(neighbor)) {
          component.add(neighbor);
          unvisited.delete(neighbor);
          pending.push(neighbor);
        }
      }
    }
    // 境界の接続の「残り側 → 成分側」が差し込み方向。割り込みでは成分側が子側にある
    // 接続(新しく作られた取り付け)を優先する。
    const edge = boundary.find(e => component.has(e.childId))
      ?? boundary.find(e => component.has(e.parentId) || component.has(e.childId));
    if (edge === undefined) continue;
    const inside = component.has(edge.childId) ? edge.childId : edge.parentId;
    const outside = inside === edge.childId ? edge.parentId : edge.childId;
    const insideWorld = assembly.worldTransformOf(inside);
    const outsideWorld = assembly.worldTransformOf(outside);
    if (insideWorld === null || outsideWorld === null) continue;
    const diff = sub(insideWorld.position, outsideWorld.position);
    const length = len(diff);
    if (!(length > 1e-9)) continue;
    const direction = scale(diff, 1 / length);
    for (const id of component) directions.set(id, direction);
  }
  return directions;
}

// 試し置きで置いたモジュールの表示モデル id。
function placedModelId(assembly: ShipAssembly, held: ConstructionHeld, placedId: string): string {
  const fallback = heldRootDefinition(assembly, held)?.modelId ?? FALLBACK_HELD_MODEL_ID;
  if (held.kind === 'catalog') return SHIP_MODULE_CATALOG.require(held.definitionId).modelId;
  if (held.kind === 'piece') return assembly.definition(placedId)?.modelId ?? fallback;
  const original = placedId.slice(placedId.indexOf(':') + 1);
  return held.piece.definition(original)?.modelId ?? fallback;
}

// ノードの状態を種別クラスへ写す。不適合と指している状態で修飾を足す。
function nodeClass(valid: boolean, pointed: boolean): string {
  let cls = NODE_CLS;
  if (!valid) cls += ' mk-construction-node-invalid';
  if (pointed) cls += ' mk-construction-node-pointed';
  return cls;
}

// 接続ノードを出す間か。手に何かを持っている間と、付け替え先として編集できる
// モジュールを選んでいる間。
export function constructionNodesVisible(
  held: ConstructionHeld | null, selectedModuleId: string | null,
  canEditModule: (moduleId: string) => boolean,
): boolean {
  return held !== null || (selectedModuleId !== null && canEditModule(selectedModuleId));
}

// ドラッグで持ち運んでいるものの姿。ポインタを通る視線の、注視距離の位置へ置き、
// 先端部・設計図は形ごと運ぶ。配置の可否が決まっていない姿なので、色は中間色
// (floating)で出す。
function carriedGhostDisplays(
  ship: ConstructionViewShip, anchorId: string, camera: CameraFrame,
  held: ConstructionHeld, point: { readonly x: number; readonly y: number },
  orientation: ModuleOrientation,
): ShipGhostDisplay[] {
  const ray = rayThroughScreen(
    camera.viewpoint, point.x, point.y, camera.viewport.width, camera.viewport.height,
  );
  const focusDist = len(sub(camera.viewpoint.lookTarget, camera.viewpoint.position));
  const anchorEci = add(ray.origin, scale(ray.dir, focusDist));
  const att = ship.motion.att.q;
  const display = (modelId: string, offset: Vec3, rotation: Quat): ShipGhostDisplay => ({
    modelId,
    position: displayPosition(camera, add(anchorEci, qRotate(att, offset))),
    rotation: qMul(att, rotation),
    valid: true,
    floating: true,
  });
  const mountRot = orientationRotation(orientation);
  if (held.kind === 'catalog') {
    const modelId = heldRootDefinition(ship.assembly, held)?.modelId ?? FALLBACK_HELD_MODEL_ID;
    return [display(modelId, ZERO, mountRot)];
  }
  if (held.kind === 'piece') {
    // 船体から切り離す前の先端部を、現在の形のまま運ぶ。
    const piece = pieceOfModule(ship.assembly.graph, anchorId, held.moduleId);
    const rootPos = ship.assembly.worldTransformOf(held.moduleId)?.position;
    if (piece === null || rootPos === undefined) return [];
    const displays: ShipGhostDisplay[] = [];
    for (const id of piece.moduleIds) {
      const transform = ship.assembly.worldTransformOf(id);
      const modelId = ship.assembly.definition(id)?.modelId ?? null;
      if (transform === null || modelId === null) continue;
      displays.push(display(modelId, sub(transform.position, rootPos), transform.rotation));
    }
    return displays;
  }
  // 設計図の写し。根元へ向きを当てた姿でまとめて運ぶ。
  const rootId = pieceRootId(held.piece);
  const rootTransform = rootId === null ? null : held.piece.worldTransformOf(rootId);
  if (rootId === null || rootTransform === null) return [];
  const displays: ShipGhostDisplay[] = [];
  for (const id of held.piece.moduleIds) {
    const transform = held.piece.worldTransformOf(id);
    const modelId = held.piece.definition(id)?.modelId ?? null;
    if (transform === null || modelId === null) continue;
    displays.push(display(
      modelId,
      qRotate(mountRot, sub(transform.position, rootTransform.position)),
      qMul(mountRot, transform.rotation),
    ));
  }
  return displays;
}

// 指している不適合ノードの脇へ出す理由。規則の判定が不適合なら規則の理由、規則を
// 通るが試し置きが不適合(重なり)なら試し置きの理由。指していないノードと有効な
// ノードには付けない。
function nodeLabel(
  guide: ConstructionTargetGuide, valid: boolean, pointed: boolean,
  trial: ConstructionTrial | null,
): string | null {
  if (valid || !pointed) return null;
  return (guide.placement.valid ? trial?.reason : guide.placement.reason) ?? null;
}

// 全取り付け先のガイドを、接続ノードのマーカー宣言へ写す。有効/無効は取り付け規則
// だけで決め、指している候補には試し置きの結果も畳む。
export function constructionNodeDeclarations(
  guides: readonly ConstructionTargetGuide[],
  pointedTargetId: string | null,
  trial: ConstructionTrial | null,
  project: ProjectFn,
  occluded: (nodeEci: Vec3) => boolean,
  cameraPos: Vec3,
): MarkerDeclaration[] {
  // 各取り付け先のガイドを1つのマーカー宣言へ写す。
  const declarations: MarkerDeclaration[] = [];
  for (const guide of guides) {
    const targetId = constructionTargetId(guide.target);
    const pointed = targetId === pointedTargetId;
    const valid = guide.placement.valid && (!pointed || (trial?.valid ?? true));
    const projected = project(guide.guideEci);
    const label = nodeLabel(guide, valid, pointed, trial);
    declarations.push({
      id: `construction-node:${targetId}`,
      cls: nodeClass(valid, pointed),
      sym: CONSTRUCTION_NODE_GLYPH,
      x: projected.x,
      y: projected.y,
      front: projected.front,
      ...(label === null ? {} : { label }),
      occluded: occluded(guide.guideEci),
      dist: len(sub(guide.guideEci, cameraPos)),
      priority: MARKER_PRIORITY.NONE,
      iconHidable: false,
    });
  }
  return declarations;
}

// 建造セッションの読み取り面を、接続ノードのマーカー群と 3D のガイド・ゴーストへ同期する。
// 指している候補の追跡・処理済みの操作記録は表示履歴として持つ(捨ててよい記憶)。
export class ShipConstructionView {
  private readonly ghost: ShipGhostView;
  private readonly guide: DockSnapGuideView;
  private readonly ring: RotationRingView;
  private readonly nodes: MarkerSink;
  // 直近の配置・付け替えの差し込み。開始時刻とモジュールごとの差し込み方向(assembly 座標)。
  private insertion: {
    readonly startMs: number;
    readonly directions: ReadonlyMap<string, Vec3>;
  } | null = null;
  private lastPointedId: string | null = null;
  private seenOperationSequence = 0;
  private seenDeniedSequence = 0;
  private seenInsertionSequence = 0;
  private previousShip: ConstructionViewShip | null = null;

  // 表示の器(ゴースト・ガイド・リング・マーカー群)を構築する。
  public constructor(scene: THREE.Scene, markers: MarkerDevice) {
    this.ghost = new ShipGhostView(scene);
    this.guide = new DockSnapGuideView(scene);
    this.ring = new RotationRingView(scene);
    this.nodes = markers.createGroup();
  }

  // セッションの読み取り面と、このフレームのカメラ・実時刻 nowMs [ms] から表示を組む。
  // 同じ入力には同じ宣言を返す。戻り値の宣言は呼び側の同期経路へ載せる。
  public sync(
    source: ShipConstructionViewSource, camera: CameraFrame, nowMs: number,
  ): ConstructionViewSyncResult {
    const ship = source.sessionShip;
    const anchorId = source.anchorId;
    const sounds = this.soundCues(source, ship);
    // セッションが無い間は、各表示物を畳む。
    if (ship === null || anchorId === null) {
      source.syncSelectionMenu(null);
      this.ghost.sync([]);
      this.guide.syncAll([]);
      this.ring.sync(null);
      this.nodes.sync([], nowMs);
      this.insertion = null;
      return { shipModuleEmphasis: null, sounds };
    }
    const trial = source.pointedTrial();
    source.syncSelectionMenu(this.selectionAnchor(source, ship, camera));
    // 読み取り面から、ノード・ガイド・リング・ゴースト・強調を同期する。
    this.syncNodes(source, ship, camera, trial, nowMs);
    this.syncGuide(source, camera, trial);
    this.syncRotationRing(source, ship, camera);
    this.syncGhosts(source, ship, anchorId, camera, trial);
    const emphasis = this.emphasisOf(source, ship, anchorId, trial, nowMs);
    return {
      shipModuleEmphasis: emphasis === null ? null : new Map([[ship.id, emphasis]]),
      sounds,
    };
  }

  // 表示装置と表示履歴を畳む。
  public dispose(): void {
    this.ghost.dispose();
    this.guide.dispose();
    this.ring.dispose();
    this.nodes.dispose();
  }

  // ---- 内部の導出 ----

  // 選択中モジュールの ECI 位置を画面座標へ投影した、選択メニューの追従先。
  // 選択が無い・モジュールが読めないときは null。画面外やカメラ背後(front=false)の
  // 投影もそのまま渡し、画面内へ寄せて残すのはメニュー側の仕事。
  private selectionAnchor(
    source: ShipConstructionViewSource, ship: ConstructionViewShip, camera: CameraFrame,
  ): Projected | null {
    const moduleId = source.selectedModuleId;
    if (moduleId === null) return null;
    const transform = ship.assembly.worldTransformOf(moduleId);
    if (transform === null) return null;
    return camera.project(ship.motion.assemblyToEci(transform.position));
  }

  // 接続ノード: 手に持っている間と、付け替え先として編集できるモジュールを選んでいる
  // 間、全取り付け先を画面へ写して宣言する。
  private syncNodes(
    source: ShipConstructionViewSource, ship: ConstructionViewShip,
    camera: CameraFrame, trial: ConstructionTrial | null, nowMs: number,
  ): void {
    // ノードを出す間だけ、全取り付け先のガイドをマーカー宣言へ写す。
    const declarations = constructionNodesVisible(
      source.held, source.selectedModuleId,
      (moduleId) => source.canEditModule(moduleId),
    )
      ? constructionNodeDeclarations(
        source.targetGuides(), source.pointedTargetId, trial,
        camera.project, (nodeEci) => this.occludedByHull(ship, camera, nodeEci),
        camera.position,
      )
      : [];
    this.nodes.sync(declarations, nowMs);
  }

  // カメラからノードへの線分が、ノードより手前で船体へ当たるか。
  private occludedByHull(ship: ConstructionViewShip, camera: CameraFrame, nodeEci: Vec3): boolean {
    const toNode = sub(nodeEci, camera.position);
    const distance = len(toNode);
    if (!(distance > 0)) return false;
    const hit = ship.motion.raycastCompound(
      { origin: camera.position, dir: scale(toNode, 1 / distance) },
      ship.motion.state.r,
    );
    return hit !== null && hit.distance < distance - OCCLUSION_MARGIN_M;
  }

  // 指している取り付け先だけへ接続面のリングを出す。
  private syncGuide(
    source: ShipConstructionViewSource, camera: CameraFrame, trial: ConstructionTrial | null,
  ): void {
    const displays: DockSnapGuideDisplay[] = [];
    const guide = source.pointedGuide();
    if (guide !== null) {
      displays.push({
        id: constructionTargetId(guide.target),
        position: displayPosition(camera, guide.guideEci),
        rotation: qFromUnitVectors(LOCAL_FORWARD, guide.normalEci),
        radius: guide.guideRadius,
        // 規則の判定と試し置きの両方が有効なときだけ有効。
        valid: guide.placement.valid && (trial?.valid ?? false),
        selected: true,
      });
    }
    this.guide.syncAll(displays);
  }

  // 選択中モジュールの回転リング。編集できるモジュールを選んでいて、手に何も
  // 持っていない間だけ出す。ドラッグ中は弧とスナップ位置をリングへ渡す。
  private syncRotationRing(
    source: ShipConstructionViewSource, ship: ConstructionViewShip, camera: CameraFrame,
  ): void {
    const moduleId = source.selectedModuleId;
    const ring = moduleId !== null && source.held === null && source.canEditModule(moduleId)
      ? constructionRotationRing(ship, moduleId)
      : null;
    // 掴んだドラッグの角度もリングへ渡す。
    this.ring.sync(ring === null ? null : {
      position: displayPosition(camera, ring.centerEci),
      rotation: ring.rotation,
      radius: ring.radius,
      drag: source.rotationDrag,
    });
  }

  // 試し置きで置いたモジュールをゴーストとして出す。置くものを持っていなければ出さない。
  // 指している候補が無い間は、ドラッグで持ち運んでいるものをポインタの先へ浮かべる。
  private syncGhosts(
    source: ShipConstructionViewSource, ship: ConstructionViewShip, anchorId: string,
    camera: CameraFrame, trial: ConstructionTrial | null,
  ): void {
    const displays: ShipGhostDisplay[] = [];
    // 試し置きがあれば置いた姿を出し、無い間はドラッグ中の持ち物をポインタの先へ浮かべる。
    const held = source.held ?? (source.selectedModuleId === null
      ? null : { kind: 'piece' as const, moduleId: source.selectedModuleId });
    if (held !== null && trial !== null) {
      for (const placed of trial.placed) {
        displays.push({
          modelId: placedModelId(ship.assembly, held, placed.moduleId),
          position: displayPosition(camera, ship.motion.assemblyToEci(placed.transform.position)),
          rotation: qMul(ship.motion.att.q, placed.transform.rotation),
          valid: trial.valid,
        });
      }
    } else if (held !== null && source.dragPoint !== null) {
      displays.push(...carriedGhostDisplays(
        ship, anchorId, camera, held, source.dragPoint, source.heldOrientation,
      ));
    }
    this.ghost.sync(displays);
  }

  // モジュールごとの強調とずらしの宣言を組む。選んだモジュールとその先端部、置くと重なる
  // 相手、直近の操作で差し込み中のモジュール、手が空いている間のポインタの下の
  // モジュールが対象。
  private emphasisOf(
    source: ShipConstructionViewSource, ship: ConstructionViewShip, anchorId: string,
    trial: ConstructionTrial | null, nowMs: number,
  ): ReadonlyMap<string, ShipModuleEmphasis> | null {
    const emphasis = new Map<string, ShipModuleEmphasis>();
    const selectedId = source.selectedModuleId;
    if (selectedId !== null) {
      const piece = pieceOfModule(ship.assembly.graph, anchorId, selectedId);
      if (piece !== null) {
        for (const id of piece.moduleIds) {
          if (id !== selectedId) {
            emphasis.set(id, { tone: 'piece', intensity: PIECE_INTENSITY, offset: ZERO });
          }
        }
      }
      emphasis.set(selectedId, { tone: 'selected', intensity: SELECTED_INTENSITY, offset: ZERO });
    }
    // ホバー中の選べるモジュールは選択中より弱く光らせる。選択・先端部・重なりの
    // 強調のほうを優先する。
    const hoveredId = source.held === null ? source.hoveredModuleId : null;
    if (hoveredId !== null && hoveredId !== selectedId && hoveredId !== anchorId
      && source.canEditModule(hoveredId) && !emphasis.has(hoveredId)) {
      emphasis.set(hoveredId, { tone: 'selected', intensity: HOVERED_INTENSITY, offset: ZERO });
    }
    for (const id of trial?.overlapModuleIds ?? []) {
      emphasis.set(id, { tone: 'conflict', intensity: conflictIntensityAt(nowMs), offset: ZERO });
    }
    this.followInsertion(source, ship, anchorId, nowMs);
    const insertion = this.insertion;
    if (insertion !== null) {
      const magnitude = insertionOffsetAt(nowMs - insertion.startMs);
      if (magnitude <= 0) this.insertion = null;
      else {
        for (const [id, direction] of insertion.directions) {
          const offset = scale(direction, magnitude);
          const existing = emphasis.get(id);
          emphasis.set(id, existing === undefined
            ? { tone: 'piece', intensity: 0, offset }
            : { ...existing, offset: add(existing.offset, offset) });
        }
      }
    }
    return emphasis.size === 0 ? null : emphasis;
  }

  // 新しい配置・付け替えの記録を見たとき、差し込みの開始時刻と方向を記録する。
  private followInsertion(
    source: ShipConstructionViewSource, ship: ConstructionViewShip,
    anchorId: string, nowMs: number,
  ): void {
    // 未処理の配置・付け替えの記録を見たときだけ、差し込みを始める。
    const operation = source.lastOperation;
    if (operation === null || operation.sequence <= this.seenInsertionSequence) return;
    this.seenInsertionSequence = operation.sequence;
    if (operation.kind !== 'place' && operation.kind !== 'move') return;
    let movedIds: ReadonlySet<string>;
    if (operation.kind === 'move') {
      const rootId = operation.moduleIds[0];
      const piece = rootId === undefined
        ? null : pieceOfModule(ship.assembly.graph, anchorId, rootId);
      if (piece === null) return;
      movedIds = piece.moduleIds;
    } else {
      movedIds = new Set(operation.moduleIds);
    }
    const directions = insertionDirections(ship.assembly, movedIds);
    if (directions.size === 0) return;
    this.insertion = { startMs: nowMs, directions };
  }

  // そのフレームに鳴らす操作音の種別を組む。記録の通し番号で処理済みを追い、同じ出来事を
  // 二度鳴らさない。
  private soundCues(
    source: ShipConstructionViewSource, ship: ConstructionViewShip | null,
  ): ConstructionSound[] {
    const sounds: ConstructionSound[] = [];
    // 吸着: 指す候補が別の候補へ移ったときだけ。
    const pointed = ship === null ? null : source.pointedTargetId;
    if (pointed !== this.lastPointedId && pointed !== null) sounds.push('snap');
    this.lastPointedId = pointed;
    // 配置・付け替え・撤去: 未処理の操作記録だけ鳴らす。
    const operation = source.lastOperation;
    if (operation !== null && operation.sequence > this.seenOperationSequence) {
      this.seenOperationSequence = operation.sequence;
      if (operation.kind === 'place' || operation.kind === 'move') sounds.push('place');
      else if (operation.kind === 'remove') sounds.push('remove');
    }
    // 不可: 未処理の拒否記録だけ鳴らす。
    const denied = source.lastDenied;
    if (denied !== null && denied.sequence > this.seenDeniedSequence) {
      this.seenDeniedSequence = denied.sequence;
      sounds.push('deny');
    }
    // 終了: 開いていたセッションが閉じた、または別の船体のセッションへ切り替わったとき。
    if (this.previousShip !== null && ship !== this.previousShip) sounds.push('finish');
    this.previousShip = ship;
    return sounds;
  }
}
