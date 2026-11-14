// 船体の接続木を無向グラフとして扱い、先端部の切り出しと根の組み直しを行う純関数。
// 先端部は起点モジュールから見て、あるモジュールより先にある部分集合とその根元の接続1本。
import { Q_IDENTITY } from '../../math/quat';
import { v3 } from '../../math/vec3';
import { copyTransform, inverseTransform } from './ship-assembly-transform';
import type { ModuleTransform, ShipAssemblyNode, ShipConnection } from './ship-assembly-types';

// 起点から見た先端部。moduleIds は先端部に含まれるモジュール、
// rootConnection は先端部と残りを繋いでいた1本の接続。
export interface AssemblyPiece {
  readonly moduleIds: ReadonlySet<string>;
  readonly rootConnection: ShipConnection;
}

// 無向グラフで current に接続する隣のモジュールを返す。接続が無ければ null。
function neighborOf(connection: ShipConnection, current: string): string | null {
  if (connection.parentId === current) return connection.childId;
  if (connection.childId === current) return connection.parentId;
  return null;
}

// from から to への無向経路で、to へ入った接続を返す。辿れなければ null。
function firstEdgeInto(
  connections: readonly ShipConnection[], from: string, to: string,
): ShipConnection | null {
  // from から幅優先で辿り、to へ到達した時点で打ち切る。
  const seen = new Set([from]);
  const entering = new Map<string, ShipConnection>();
  const pending = [from];
  while (pending.length > 0 && !entering.has(to)) {
    const current = pending.shift()!;
    for (const edge of connections) {
      const neighbor = neighborOf(edge, current);
      if (neighbor === null || seen.has(neighbor)) continue;
      seen.add(neighbor);
      entering.set(neighbor, edge);
      pending.push(neighbor);
    }
  }
  return entering.get(to) ?? null;
}

// anchorId から見て moduleId より先にある部分を返す。moduleId 自身と、moduleId から
// anchorId 側以外へ伸びるモジュールが先端部になる。moduleId === anchorId、または
// moduleId へ anchorId から辿れないときは null。
export function pieceOfModule(
  connections: readonly ShipConnection[], anchorId: string, moduleId: string,
): AssemblyPiece | null {
  if (anchorId === moduleId) return null;
  const rootConnection = firstEdgeInto(connections, anchorId, moduleId);
  if (rootConnection === null) return null;
  // 根元の接続を渡らずに moduleId から辿れる集合。
  const moduleIds = new Set([moduleId]);
  const pending = [moduleId];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const edge of connections) {
      if (edge.id === rootConnection.id) continue;
      const neighbor = neighborOf(edge, current);
      if (neighbor !== null && !moduleIds.has(neighbor)) {
        moduleIds.add(neighbor);
        pending.push(neighbor);
      }
    }
  }
  return { moduleIds, rootConnection };
}

// 接続木を rootId を根として組み直す。モジュールどうしの変換を保ち、根から遠い側を子とする。
// 逆向きに組み直す接続は子の変換を逆変換で表し、側面接続はスロットの持ち主に合わせて
// sideReversed を付け直す。モジュールの状態は入力と同じ参照のまま渡す。
export function rerootedAssembly(
  nodes: ReadonlyMap<string, ShipAssemblyNode>,
  connections: readonly ShipConnection[],
  rootId: string,
): { readonly nodes: ReadonlyMap<string, ShipAssemblyNode>; readonly connections: readonly ShipConnection[] } {
  if (!nodes.has(rootId)) throw new Error(`unknown root module: ${rootId}`);
  // 無向グラフを根から BFS して、各モジュールの根側の接続と新しい親を求める。
  const parentOf = new Map<string, { edge: ShipConnection; parentId: string }>();
  const seen = new Set([rootId]);
  const pending = [rootId];
  while (pending.length > 0) {
    const current = pending.shift()!;
    for (const edge of connections) {
      const neighbor = neighborOf(edge, current);
      if (neighbor === null || seen.has(neighbor) || !nodes.has(neighbor)) continue;
      seen.add(neighbor);
      parentOf.set(neighbor, { edge, parentId: current });
      pending.push(neighbor);
    }
  }
  if (seen.size !== nodes.size) throw new Error('assembly graph is disconnected');

  const rerootedNodes = new Map<string, ShipAssemblyNode>();
  for (const [id, node] of nodes) {
    const entry = parentOf.get(id);
    const transform: ModuleTransform = entry === undefined
      ? { position: v3(), rotation: { ...Q_IDENTITY } }
      : entry.edge.parentId === entry.parentId
        ? copyTransform(entry.edge.childTransform)
        : inverseTransform(entry.edge.childTransform);
    rerootedNodes.set(id, { instance: node.instance, transform });
  }

  const rerootedConnections = connections.map((edge) => {
    // BFS で子へ入った接続なら元の向き、そうでなければ逆向き。
    const forward = parentOf.get(edge.childId)?.edge === edge;
    const childTransform = forward
      ? copyTransform(edge.childTransform) : inverseTransform(edge.childTransform);
    // 側面スロットの持ち主は変換の向きとは無関係に固定する。
    const slotOwnerId = edge.sideReversed ? edge.childId : edge.parentId;
    return {
      id: edge.id,
      parentId: forward ? edge.parentId : edge.childId,
      childId: forward ? edge.childId : edge.parentId,
      kind: edge.kind,
      childTransform,
      ...(edge.sideSlot === undefined ? {} : { sideSlot: edge.sideSlot }),
      ...(edge.kind === 'side' && slotOwnerId === (forward ? edge.childId : edge.parentId)
        ? { sideReversed: true } : {}),
    };
  });
  return { nodes: rerootedNodes, connections: rerootedConnections };
}
