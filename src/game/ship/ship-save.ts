// ship v4 の assembly・建造予約・接舷 identity を検証し、実行時状態と相互変換する。
import { v3 } from '../../math/vec3';
import type {
  DockedVesselSaveData, ShipAssemblySaveData, ShipConnectionSaveData,
  ShipConstructionDraftSaveData, ShipModuleSaveData,
} from '../save/save-data';
import { ShipAssembly } from './ship-assembly';
import { SHIP_MODULE_CATALOG } from './ship-module-catalog';
import { createShipModuleInstance, type ShipModuleInstance } from './ship-module-instance';
import type { ShipConstructionDraftState } from './ship-dock-state';

function finite(value: number): boolean { return Number.isFinite(value); }

function validConnectionKind(value: unknown): value is ShipConnectionSaveData['kind'] {
  return value === 'axial' || value === 'side' || value === 'docking';
}

function validTransform(connection: ShipConnectionSaveData): boolean {
  const { position: p, rotation: q } = connection;
  return finite(p.x) && finite(p.y) && finite(p.z)
    && finite(q.x) && finite(q.y) && finite(q.z) && finite(q.w)
    && Math.hypot(q.x, q.y, q.z, q.w) > 1e-12;
}

// definition の discriminant と可変値を検証し、正規化済み instance を返す。
function moduleState(saved: ShipModuleSaveData): ShipModuleInstance {
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
export function serializeShipAssembly(assembly: ShipAssembly): ShipAssemblySaveData {
  return {
    playerOwned: assembly.playerOwned,
    modules: assembly.modules.map(module => ({ ...module })),
    connections: assembly.graph.map(connection => ({
      id: connection.id,
      parentId: connection.parentId,
      childId: connection.childId,
      kind: connection.kind,
      position: { ...connection.childTransform.position },
      rotation: { ...connection.childTransform.rotation },
    })),
  };
}

// v4 の保存形を検証し、接続木の親から子へ assembly を復元する。
export function restoreShipAssembly(saved: ShipAssemblySaveData): ShipAssembly {
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
    assembly.addModule(module, connection.parentId, {
      position: v3(connection.position.x, connection.position.y, connection.position.z),
      rotation: { ...connection.rotation },
    }, connection.kind, connection.id);
  }
  assembly.assertValid();
  return assembly;
}

// 建造予約が現在の dock と assembly graph を参照することを検証して複製する。
export function restoreConstructionDrafts(
  saved: readonly ShipConstructionDraftSaveData[], assembly: ShipAssembly,
): readonly ShipConstructionDraftState[] {
  if (!Array.isArray(saved)) throw new Error('invalid ship dock state');
  const docks = new Set<string>();
  return saved.map((draft) => {
    const dock = assembly.module(draft.dockId);
    if (dock?.kind !== 'dock' || docks.has(draft.dockId)
      || assembly.isDockingPortOccupied(draft.dockId)
      || !Array.isArray(draft.addedIds)
      || draft.addedIds.some((id: unknown) => typeof id !== 'string' || assembly.module(id) === null)
      || assembly.module(draft.axialTailId) === null
      || (draft.firstConnectionId !== null
        && !assembly.graph.some(connection => connection.id === draft.firstConnectionId))) {
      throw new Error(`invalid construction draft: ${draft.dockId}`);
    }
    docks.add(draft.dockId);
    return { ...draft, addedIds: [...draft.addedIds] };
  });
}

// 接舷船 identity が現在の docking edge と一対一に対応することを検証する。
export function restoreDockedVessels(
  saved: readonly DockedVesselSaveData[], assembly: ShipAssembly,
): readonly DockedVesselSaveData[] {
  if (!Array.isArray(saved)) throw new Error('invalid docked vessel state');
  const connectionIds = new Set(assembly.dockingConnections().map(connection => connection.id));
  const seen = new Set<string>();
  return saved.map((record) => {
    if (!connectionIds.has(record.connectionId) || seen.has(record.connectionId)
      || typeof record.id !== 'string' || record.id.length === 0
      || typeof record.name !== 'string') {
      throw new Error(`invalid docked vessel record: ${record.connectionId}`);
    }
    seen.add(record.connectionId);
    return { ...record };
  });
}
