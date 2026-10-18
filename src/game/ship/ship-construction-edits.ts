// 建造の船体編集命令: 置く・付け替える・撤去する・割り込む・回す・写しで置き換える。
// 各命令は適用時に規則(placementFor)で再検証し、写しへの適用が終わってから実体を差し替える。
import { createShipModuleInstance } from './ship-module-instance';
import { placementFor } from './ship-construction-rules';
import { tryConstructionPlacement } from './ship-construction-preview';
import { pieceOfModule, type AssemblyPiece } from './ship-assembly-graft';
import {
  axialMountTransform, axialPlacementFromTransform, inverseTransform, sideMountTransform,
  type ModuleOrientation,
} from './ship-assembly-transform';
import type { ModuleTransform, SideSlot } from './ship-assembly-types';
import type { ShipAssembly } from './ship-assembly';
import { restoreShipAssembly, type SerializedShipAssembly } from './ship-save';
import type { ConstructionHeld, ConstructionSymmetry, ConstructionTarget } from './ship-construction-types';

// 編集を受ける船体の読み取り・同期面。ドックの状態は assembly の接続から読む。
export interface ConstructionShip {
  readonly assembly: ShipAssembly;
  readonly capabilities: { readonly controllable: boolean };
  readonly motion: { readonly alive: boolean };
  synchronizeAssemblyState(): void;
}

export class ShipConstructionEdits {
  public constructor(private readonly ship: ConstructionShip, private readonly anchorId: string) {}

  // 手持ちを取り付け先へ置く。newIds は接ぎ木ごとの新しい識別子(写しは接ぎ木ごとの接頭辞)。
  public place(
    held: ConstructionHeld, target: ConstructionTarget,
    orientation: ModuleOrientation, symmetry: ConstructionSymmetry, newIds: readonly string[],
  ): void {
    this.validateAnchor();
    const { assembly } = this.ship;
    if (held.kind === 'piece') this.requireEditablePiece(held.moduleId);
    // 規則と重なりの両方を含む試し置きで再検証し、計画だけを本適用へ回す。
    const trial = tryConstructionPlacement(assembly, this.anchorId, held, target, orientation, symmetry);
    if (!trial.valid) throw new Error(trial.reason ?? '配置できません');
    const placement = placementFor(assembly, this.anchorId, held, target, orientation, symmetry);
    if (!placement.valid) throw new Error(placement.reason ?? '配置できません');

    const work = assembly.clone();
    // 付け替えは先端部を先に切り離す。対称を持たないので接ぎ木は1本。
    let detached: ShipAssembly | null = null;
    let detachedConnectionId: string | null = null;
    if (held.kind === 'piece') {
      detachedConnectionId = pieceOfModule(work.graph, this.anchorId, held.moduleId)?.rootConnection.id ?? null;
      detached = work.detachPiece(held.moduleId, this.anchorId);
    }
    let placedRootId: string | null = null;
    for (const [index, plan] of placement.attachments.entries()) {
      if (held.kind === 'piece') {
        const piece = detached!;
        placedRootId ??= pieceRootIdOf(piece);
        work.attachPiece(
          piece, plan.parentId, plan.transform, plan.connectionKind,
          plan.sideSlot ?? undefined, undefined, detachedConnectionId ?? undefined,
        );
        continue;
      }
      const id = newIds[index];
      if (id === undefined) throw new Error('配置に使う識別子が足りません');
      if (held.kind === 'catalog') {
        const definition = work.catalog.require(held.definitionId);
        work.addModule(
          createShipModuleInstance(definition, id), plan.parentId, plan.transform,
          plan.connectionKind, undefined, plan.sideSlot ?? undefined,
        );
        placedRootId ??= id;
      } else {
        const piece = held.piece.copiedAsNew(id);
        placedRootId ??= pieceRootIdOf(piece);
        work.attachPiece(
          piece, plan.parentId, plan.transform, plan.connectionKind,
          plan.sideSlot ?? undefined,
        );
      }
    }
    // 継ぎ目の先の部分を、割り込ませたモジュールの反対側の端へ付き直す。
    if (placement.reattachment !== null && placedRootId !== null) {
      const far = work.detachPiece(placement.reattachment.farModuleId, this.anchorId);
      work.attachPiece(
        far, placedRootId, placement.reattachment.transform, 'axial',
        undefined, undefined, placement.reattachment.connectionId,
      );
    }
    assembly.replaceWith(work);
    this.ship.synchronizeAssemblyState();
  }

  // 配置済みモジュールを先端部ごと取り付け先へ付け替える。識別子と状態は保つ。
  public move(moduleId: string, target: ConstructionTarget, orientation: ModuleOrientation): void {
    this.place({ kind: 'piece', moduleId }, target, orientation, 1, []);
  }

  // モジュールを先端部ごと撤去する。
  public remove(moduleId: string): void {
    this.validateAnchor();
    this.requireEditablePiece(moduleId);
    const work = this.ship.assembly.clone();
    work.detachPiece(moduleId, this.anchorId);
    this.ship.assembly.replaceWith(work);
    this.ship.synchronizeAssemblyState();
  }

  // 軸方向の継ぎ目へ、両端に取り付け面を持つカタログの部品を割り込ませる。
  public insert(definitionId: string, connectionId: string, orientation: ModuleOrientation, newId: string): void {
    this.place(
      { kind: 'catalog', definitionId }, { kind: 'joint', connectionId }, orientation, 1, [newId],
    );
  }

  // 配置済みモジュールを根元の接続のまわりへ回す。先端部ごと回り、識別子と接続は保つ。
  public reorient(moduleId: string, orientation: ModuleOrientation): void {
    this.validateAnchor();
    const { assembly } = this.ship;
    const piece = this.requireEditablePiece(moduleId);
    const edge = piece.rootConnection;
    const otherId = edge.parentId === moduleId ? edge.childId : edge.parentId;
    const moduleDefinition = assembly.definition(moduleId);
    const otherDefinition = assembly.definition(otherId);
    if (moduleDefinition === null || otherDefinition === null) throw new Error('接続先の部品がありません');

    // 先端部の根の、anchor側のモジュールを親とした取り付け変換へ正規化する。
    const mounted: ModuleTransform = edge.parentId === moduleId
      ? inverseTransform(edge.childTransform) : edge.childTransform;
    let transform: ModuleTransform;
    let sideSlot: SideSlot | null = null;
    let sideReversed = false;
    if (edge.kind === 'side') {
      // 側面接続の回しは取り付け軸まわりのロールだけが効く。
      sideSlot = edge.sideSlot ?? null;
      if (sideSlot === null) throw new Error('側面の取り付け位置が分かりません');
      sideReversed = edge.sideReversed === true ? moduleId === edge.childId : moduleId === edge.parentId;
      const ownerId = edge.sideReversed === true ? edge.childId : edge.parentId;
      // スロットの持ち主を親とした取り付け変換を組み、持ち主自身が根なら逆変換で表す。
      const ownerIsRoot = ownerId === moduleId;
      const ownerDefinition = ownerIsRoot ? moduleDefinition : otherDefinition;
      const childDefinition = ownerIsRoot ? otherDefinition : moduleDefinition;
      const forward = sideMountTransform(ownerDefinition, childDefinition, sideSlot, orientation.roll);
      transform = ownerIsRoot ? inverseTransform(forward) : forward;
    } else {
      const placement = axialPlacementFromTransform(mounted);
      if (placement === null) throw new Error('軸方向の取り付け変換が読めません');
      if (moduleDefinition.axialFaces[orientation.face] !== 'structural') {
        throw new Error('その面では取り付けられません');
      }
      transform = axialMountTransform(otherDefinition, moduleDefinition, placement.parentFace, orientation);
    }

    const work = assembly.clone();
    const detached = work.detachPiece(moduleId, this.anchorId);
    work.attachPiece(detached, otherId, transform, edge.kind, sideSlot ?? undefined, sideReversed, edge.id);
    assembly.replaceWith(work);
    this.ship.synchronizeAssemblyState();
  }

  // 船体を直列化した写しの時点へ戻す。戻す先に起点ドックが無い写しは拒否する。
  public replaceAssembly(serialized: SerializedShipAssembly): void {
    this.validateAnchor();
    const restored = restoreShipAssembly(serialized);
    const anchor = restored.module(this.anchorId);
    if (anchor?.kind !== 'dock' || anchor.hp <= 0) {
      throw new Error('戻す先の船体に起点のドックがありません');
    }
    this.ship.assembly.replaceWith(restored);
    this.ship.synchronizeAssemblyState();
  }

  // 撤去・付け替え・回転の対象が、起点ドックから見た先端部として掴めることを確かめる。
  // 接舷の継ぎ目を跨ぐ先端部は他の船体の一部分なので、建造の操作対象にしない。
  private requireEditablePiece(moduleId: string): AssemblyPiece {
    if (moduleId === this.anchorId) throw new Error('起点のドックは動かせません');
    const piece = pieceOfModule(this.ship.assembly.graph, this.anchorId, moduleId);
    if (piece === null) throw new Error('その部品は掴めません');
    if (piece.rootConnection.kind === 'docking') {
      throw new Error('接舷中の接続の先は、建造では編集できません');
    }
    return piece;
  }

  // 失われた船体・破壊済みのドックへの編集を拒否する。接続中のドックは編集できる。
  private validateAnchor(): void {
    const module = this.ship.assembly.module(this.anchorId);
    if (!this.ship.motion.alive) throw new Error('対象船体が存在しません');
    if (module?.kind !== 'dock') throw new Error(`not a construction dock: ${this.anchorId}`);
    if (module.hp <= 0) throw new Error('健全な接舷部が必要です');
  }
}

// 接ぎ木の根(取り付けるモジュール)の id。piece は attachPiece で消費済みでも moduleIds は残る。
function pieceRootIdOf(piece: ShipAssembly): string | null {
  const childIds = new Set(piece.graph.map(edge => edge.childId));
  return piece.moduleIds.find(id => !childIds.has(id)) ?? null;
}
