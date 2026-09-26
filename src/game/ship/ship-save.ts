// ship v4 の assembly・建造予約・接舷 identity を検証し、実行時状態と相互変換する。
import { v3 } from '../../math/vec3';
import { qInvert, qRotate, type Quat } from '../../math/quat';
import type { SerializedVec3 } from '../../math/vec3';
import { SIDE_SLOTS, ShipAssembly, type SideSlot } from './ship-assembly';
import { sideMountTransform, sideSlotFromTransform } from './ship-assembly-transform';
import { SHIP_MODULE_CATALOG } from './ship-module-catalog';
import type { ShipModuleDefinition } from './ship-module-definition';
import { createShipModuleInstance, type ShipModuleInstance } from './ship-module-instance';
import type { ShipConstructionDraftState } from './ship-dock-state';

export type SerializedShipModule = {
  readonly id: string;
  readonly definitionId: string;
  readonly hp: number;
  readonly temperature: number;
} & (
  | { readonly kind: 'cockpit' | 'thruster' | 'rcs' | 'weapon' | 'armor' | 'docking_port' | 'dock' | 'decoupler' }
  | { readonly kind: 'tank'; readonly fuelKind: 'main' | 'rcs'; readonly fuel: number }
  | { readonly kind: 'radiator' | 'solar_panel'; readonly deployed: number }
  | { readonly kind: 'booster'; readonly fuel: number; readonly ignited: boolean }
);

export interface SerializedShipConnection {
  readonly id: string;
  readonly parentId: string;
  readonly childId: string;
  readonly kind: 'axial' | 'side' | 'docking' | 'construction';
  readonly sideSlot?: SideSlot;
  readonly sideReversed?: boolean;
  readonly position: SerializedVec3;
  readonly rotation: Quat;
}

export interface SerializedShipAssembly {
  readonly playerOwned: boolean;
  readonly modules: readonly SerializedShipModule[];
  readonly connections: readonly SerializedShipConnection[];
}

export interface SerializedShipConstructionDraft {
  readonly dockId: string;
  readonly addedIds: readonly string[];
  readonly axialTailId: string;
  readonly firstConnectionId: string | null;
}

export interface SerializedDockedVessel {
  readonly connectionId: string;
  readonly id: string;
  readonly name: string;
}

export interface SerializedCollisionGrace {
  readonly otherId: string;
  readonly until: number;
}

function finite(value: number): boolean { return Number.isFinite(value); }

function validConnectionKind(value: unknown): value is SerializedShipConnection['kind'] {
  return value === 'axial' || value === 'side' || value === 'docking' || value === 'construction';
}

function validSideSlot(value: unknown): value is SideSlot {
  return typeof value === 'string' && SIDE_SLOTS.includes(value as SideSlot);
}

function validTransform(connection: SerializedShipConnection): boolean {
  const { position: p, rotation: q } = connection;
  return finite(p.x) && finite(p.y) && finite(p.z)
    && finite(q.x) && finite(q.y) && finite(q.z) && finite(q.w)
    && Math.hypot(q.x, q.y, q.z, q.w) > 1e-12;
}

// 旧 3 m cockpit と現在の module 長から、移行対象と現在の軸間隔を返す。
function cockpitAxialMigrationSpacing(
  parent: ShipModuleDefinition | null,
  child: ShipModuleDefinition | null,
): { readonly previous: number; readonly current: number } | null {
  if (parent?.kind !== 'cockpit' && child?.kind !== 'cockpit') return null;
  const previousLength = (definition: ShipModuleDefinition | null): number => (
    definition?.kind === 'cockpit' ? 3 : definition?.length ?? 0
  );
  return {
    previous: (previousLength(parent) + previousLength(child)) / 2,
    current: ((parent?.length ?? 0) + (child?.length ?? 0)) / 2,
  };
}

// definition の discriminant と可変値を検証し、正規化済み instance を返す。
function moduleState(saved: SerializedShipModule): ShipModuleInstance {
  const definition = SHIP_MODULE_CATALOG.get(saved.definitionId);
  if (definition === null || definition.kind !== saved.kind) {
    throw new Error(`unknown or mismatched ship module definition: ${saved.definitionId}`);
  }
  if (saved.id.length === 0 || !finite(saved.hp) || !finite(saved.temperature)) {
    throw new Error(`invalid ship module state: ${saved.id}`);
  }
  if (saved.kind === 'tank') {
    if (!finite(saved.fuel) || definition.abilities.fuelKind !== saved.fuelKind) {
      throw new Error(`invalid tank state: ${saved.id}`);
    }
    return createShipModuleInstance(definition, saved.id, saved);
  }
  if (saved.kind === 'booster') {
    if (!finite(saved.fuel) || typeof saved.ignited !== 'boolean') {
      throw new Error(`invalid booster state: ${saved.id}`);
    }
    return createShipModuleInstance(definition, saved.id, saved);
  }
  if (saved.kind === 'radiator' || saved.kind === 'solar_panel') {
    if (!finite(saved.deployed)) throw new Error(`invalid deployable state: ${saved.id}`);
    return createShipModuleInstance(definition, saved.id, saved);
  }
  return createShipModuleInstance(definition, saved.id, saved);
}

// assembly の module state と接続木を v4 の平坦な保存形へ畳む。
export function serializeShipAssembly(assembly: ShipAssembly): SerializedShipAssembly {
  return {
    playerOwned: assembly.playerOwned,
    modules: assembly.modules.map(module => ({ ...module })),
    connections: assembly.graph.map(connection => ({
      id: connection.id,
      parentId: connection.parentId,
      childId: connection.childId,
      kind: connection.kind,
      ...(connection.sideSlot === undefined ? {} : { sideSlot: connection.sideSlot }),
      ...(connection.sideReversed ? { sideReversed: true } : {}),
      position: { ...connection.childTransform.position },
      rotation: { ...connection.childTransform.rotation },
    })),
  };
}

// v4 の保存形を検証し、接続木の親から子へ assembly を復元する。
export function restoreShipAssembly(saved: SerializedShipAssembly): ShipAssembly {
  if (typeof saved?.playerOwned !== 'boolean' || !Array.isArray(saved.modules)
    || !Array.isArray(saved.connections) || saved.modules.length === 0) {
    throw new Error('invalid ship assembly save data');
  }
  // module state と ID の一意性を接続木より先に確定する。
  const modules = new Map<string, ShipModuleInstance>();
  for (const value of saved.modules) {
    const module = moduleState(value);
    if (modules.has(module.id)) throw new Error(`duplicate saved ship module: ${module.id}`);
    modules.set(module.id, module);
  }
  if (saved.connections.length !== modules.size - 1) throw new Error('saved ship assembly is not a tree');
  // 各 edge の参照・種別・変換と、子の親が一意であることを検証する。
  const incoming = new Set<string>();
  const connectionIds = new Set<string>();
  for (const connection of saved.connections) {
    if (typeof connection?.id !== 'string' || connection.id.length === 0
      || typeof connection.parentId !== 'string' || typeof connection.childId !== 'string'
      || !validConnectionKind(connection.kind)
      || (connection.sideSlot !== undefined && !validSideSlot(connection.sideSlot))
      || (connection.sideReversed !== undefined && typeof connection.sideReversed !== 'boolean')
      || connectionIds.has(connection.id) || incoming.has(connection.childId)
      || connection.parentId === connection.childId
      || !modules.has(connection.parentId) || !modules.has(connection.childId)
      || !validTransform(connection)) {
      throw new Error(`invalid saved ship connection: ${connection.id}`);
    }
    connectionIds.add(connection.id);
    incoming.add(connection.childId);
  }
  const roots = [...modules.keys()].filter(id => !incoming.has(id));
  if (roots.length !== 1) throw new Error('saved ship assembly must have one root');

  // root から到達可能になった edge を順に取り込み、cycle と切断を検出する。
  const assembly = new ShipAssembly(SHIP_MODULE_CATALOG, saved.playerOwned);
  const rootId = roots[0];
  const root = rootId === undefined ? undefined : modules.get(rootId);
  if (root === undefined) throw new Error('saved ship assembly root is missing');
  assembly.addRoot(root);
  const pending = [...saved.connections];
  while (pending.length > 0) {
    const index = pending.findIndex(connection => assembly.module(connection.parentId) !== null);
    if (index < 0) throw new Error('saved ship assembly contains a cycle');
    const connection = pending[index];
    if (connection === undefined) throw new Error('saved ship connection is missing');
    pending.splice(index, 1);
    const module = modules.get(connection.childId);
    if (module === undefined) throw new Error(`saved ship module is missing: ${connection.childId}`);
    let childTransform = {
      position: v3(connection.position.x, connection.position.y, connection.position.z),
      rotation: { ...connection.rotation },
    };
    let sideSlot = connection.sideSlot;
    if (connection.kind === 'side') {
      const parentDefinition = assembly.definition(connection.parentId);
      const childDefinition = SHIP_MODULE_CATALOG.get(module.definitionId);
      if (connection.sideReversed) {
        if (parentDefinition !== null && childDefinition !== null && sideSlot !== undefined) {
          const forward = sideMountTransform(childDefinition, parentDefinition, sideSlot);
          const invRot = qInvert(forward.rotation);
          childTransform = {
            position: qRotate(invRot, v3(-forward.position.x, -forward.position.y, -forward.position.z)),
            rotation: invRot,
          };
        }
      } else {
        sideSlot = sideSlot ?? sideSlotFromTransform(childTransform) ?? undefined;
        if (parentDefinition !== null && childDefinition !== null && sideSlot !== undefined) {
          childTransform = sideMountTransform(parentDefinition, childDefinition, sideSlot);
        }
      }
    } else if (connection.kind === 'axial' && childTransform.position.z > 0) {
      const childDefinition = SHIP_MODULE_CATALOG.get(module.definitionId);
      if (childDefinition?.kind !== 'weapon') {
        childTransform = {
          position: v3(childTransform.position.x, childTransform.position.y, -childTransform.position.z),
          rotation: childTransform.rotation,
        };
      }
    }
    if (connection.kind === 'axial') {
      const spacing = cockpitAxialMigrationSpacing(
        assembly.definition(connection.parentId), SHIP_MODULE_CATALOG.get(module.definitionId),
      );
      if (spacing !== null && Math.abs(Math.abs(childTransform.position.z) - spacing.previous) < 1e-9) {
        const sign = childTransform.position.z < 0 ? -1 : 1;
        childTransform = {
          position: v3(childTransform.position.x, childTransform.position.y, sign * spacing.current),
          rotation: childTransform.rotation,
        };
      }
    }
    assembly.addModule(
      module, connection.parentId, childTransform, connection.kind, connection.id, sideSlot, connection.sideReversed,
    );
  }
  assembly.assertValid();
  return assembly;
}

// 建造予約が現在の dock と assembly graph を参照することを検証して複製する。
export function restoreConstructionDrafts(
  saved: readonly SerializedShipConstructionDraft[], assembly: ShipAssembly,
): readonly ShipConstructionDraftState[] {
  if (!Array.isArray(saved)) throw new Error('invalid ship dock state');
  const docks = new Set<string>();
  const added = new Set<string>();
  const firstConnections = new Set<string>();
  return saved.map((draft) => {
    if (draft === null || typeof draft !== 'object') throw new Error('invalid construction draft');
    const dock = assembly.module(draft.dockId);
    const hasAddedIds = Array.isArray(draft.addedIds);
    const ids: readonly string[] = hasAddedIds ? draft.addedIds : [];
    const edge = draft.firstConnectionId === null
      ? undefined : assembly.graph.find(connection => connection.id === draft.firstConnectionId);
    const idSet = new Set(ids);
    const reachable = new Set<string>();
    if (edge !== undefined) {
      const pending = [edge.childId];
      while (pending.length > 0) {
        const id = pending.pop();
        if (id === undefined || reachable.has(id)) continue;
        reachable.add(id);
        for (const child of assembly.graph.filter(connection => connection.parentId === id)) pending.push(child.childId);
      }
    }
    const valid = dock?.kind === 'dock'
      && typeof draft.dockId === 'string'
      && typeof draft.axialTailId === 'string'
      && (draft.firstConnectionId === null || typeof draft.firstConnectionId === 'string')
      && hasAddedIds
      && !docks.has(draft.dockId)
      && !assembly.isPortConnected(draft.dockId)
      && ids.length === idSet.size
      && ids.every((id: unknown) => typeof id === 'string' && id.length > 0
        && assembly.module(id) !== null && !added.has(id))
      && (ids.length === 0
        ? draft.firstConnectionId === null && draft.axialTailId === draft.dockId
        : draft.firstConnectionId !== null && edge !== undefined
          && !firstConnections.has(draft.firstConnectionId)
          && edge.parentId === draft.dockId
          && (edge.kind === 'axial' || edge.kind === 'side')
          && edge.childId === ids[0]
          && ids.every(id => reachable.has(id))
          && (draft.axialTailId === draft.dockId || idSet.has(draft.axialTailId)))
      && assembly.module(draft.axialTailId) !== null;
    if (!valid) {
      throw new Error(`invalid construction draft: ${draft.dockId}`);
    }
    docks.add(draft.dockId);
    for (const id of ids) added.add(id);
    if (draft.firstConnectionId !== null) firstConnections.add(draft.firstConnectionId);
    return { ...draft, addedIds: [...ids] };
  });
}

// 接舷船 identity が現在の docking edge と一対一に対応することを検証する。
export function restoreDockedVessels(
  saved: readonly SerializedDockedVessel[], assembly: ShipAssembly,
): readonly SerializedDockedVessel[] {
  if (!Array.isArray(saved)) throw new Error('invalid docked vessel state');
  const connectionIds = new Set(assembly.dockingConnections().map(connection => connection.id));
  if (saved.length !== connectionIds.size) throw new Error('docked vessel records do not match docking connections');
  const seen = new Set<string>();
  const vesselIds = new Set<string>();
  return saved.map((record) => {
    if (record === null || typeof record !== 'object'
      || typeof record.connectionId !== 'string'
      || !connectionIds.has(record.connectionId) || seen.has(record.connectionId)
      || typeof record.id !== 'string' || record.id.length === 0
      || vesselIds.has(record.id) || typeof record.name !== 'string') {
      throw new Error(`invalid docked vessel record: ${record.connectionId}`);
    }
    seen.add(record.connectionId);
    vesselIds.add(record.id);
    return { ...record };
  });
}
