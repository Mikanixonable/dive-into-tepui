// 配置計画(placementFor の結果)を assembly の写しへ適用する手順。
// 試し置き(ship-construction-preview)と本適用(ship-construction-edits)が
// 同じ接ぎ木手順をなぞるために共有する。違いは mintId が払い出す識別子だけ。
import { createShipModuleInstance } from './ship-module-instance';
import { pieceRootId, type ConstructionPlacementResult } from './ship-construction-rules';
import { pieceOfModule } from './ship-assembly-graft';
import type { ConstructionHeld } from './ship-construction-types';
import type { ShipAssembly } from './ship-assembly';

export interface ConstructionApplyResult {
  readonly placedIds: readonly string[];
  readonly placedRootId: string | null;
  // 直接接続する組(向きに依らない id の組の鍵)。接合面の接触を重なりと誤らない照合に使う。
  readonly connected: ReadonlySet<string>;
}

// work(呼び出し側で clone 済みの assembly)へ placement を適用する。
// mintId は接ぎ木 index ごとの新しい識別子(catalog なら module ID、写し接ぎ木なら接頭辞)を返す。
export function applyConstructionPlacement(
  work: ShipAssembly, anchorId: string, held: ConstructionHeld,
  placement: ConstructionPlacementResult, mintId: (index: number) => string,
): ConstructionApplyResult {
  const placedIds: string[] = [];
  const connected = new Set<string>();
  let placedRootId: string | null = null;

  // 付け替えは先端部を先に切り離す。付け替えは対称を持たないので接ぎ木は1本。
  let detached: ShipAssembly | null = null;
  let detachedConnectionId: string | null = null;
  if (held.kind === 'piece') {
    const piece = pieceOfModule(work.graph, anchorId, held.moduleId);
    detachedConnectionId = piece?.rootConnection.id ?? null;
    detached = work.detachPiece(held.moduleId, anchorId);
  }

  for (const [index, plan] of placement.attachments.entries()) {
    if (held.kind === 'catalog') {
      const definition = work.catalog.require(held.definitionId);
      const id = mintId(index);
      work.addModule(
        createShipModuleInstance(definition, id), plan.parentId, plan.transform,
        plan.connectionKind, undefined, plan.sideSlot ?? undefined,
      );
      placedRootId ??= id;
      placedIds.push(id);
      connected.add(pairKey(plan.parentId, id));
    } else {
      const piece = held.kind === 'piece' ? detached! : held.piece.copiedAsNew(mintId(index));
      const rootId = pieceRootId(piece);
      if (rootId === null) throw new Error('手に持った部品が見つかりません');
      const ids = piece.moduleIds;
      work.attachPiece(
        piece, plan.parentId, plan.transform, plan.connectionKind,
        plan.sideSlot ?? undefined, undefined, detachedConnectionId ?? undefined,
      );
      placedRootId ??= rootId;
      placedIds.push(...ids);
      connected.add(pairKey(plan.parentId, rootId));
    }
  }

  // 継ぎ目の先の部分を、割り込ませたモジュールの反対側の端へ付き直す。
  if (placement.reattachment !== null && placedRootId !== null) {
    const far = work.detachPiece(placement.reattachment.farModuleId, anchorId);
    work.attachPiece(
      far, placedRootId, placement.reattachment.transform, 'axial',
      undefined, undefined, placement.reattachment.connectionId,
    );
    connected.add(pairKey(placedRootId, placement.reattachment.farModuleId));
  }

  return { placedIds, placedRootId, connected };
}

// 2つのモジュール id の、向きに依らない組の鍵。直接接続する組の照合に使う。
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}\n${b}` : `${b}\n${a}`;
}
