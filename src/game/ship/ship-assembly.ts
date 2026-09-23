// 船体モジュールの木構造、接続変換、可変状態と分割・統合操作を所有する。
import { mulberry32 } from '../../math/random';
import {
  LOCAL_UP, Q_IDENTITY, qFromAxisAngle, qInvert, qMul, qRotate, type Quat,
} from '../../math/quat';
import { add, v3, type Vec3 } from '../../math/vec3';
import {
  SHIP_MODULE_CATALOG, type ShipModuleCatalog,
} from './ship-module-catalog';
import type { ShipModuleDefinition } from './ship-module-definition';
import { cloneShipModuleInstance, type ShipModuleInstance } from './ship-module-instance';
export type {
  ConnectionKind, DockingMergeResult, ModuleTransform, ShipAssemblyNode as AssemblyNode, ShipAssemblyTotals,
  ShipAssemblyValidation, ShipConnection, ShipRole, SideSlot,
} from './ship-assembly-types';
import {
  isDockingModule, type ConnectionKind, type DockingMergeResult, type ModuleTransform,
  type ShipAssemblyNode, type ShipAssemblyTotals, type ShipAssemblyValidation, type ShipConnection,
  type ShipRole, type SideSlot,
} from './ship-assembly-types';
import type { ShipAssemblyNode as AssemblyNode } from './ship-assembly-types';
import { shipAssemblyTotals } from './ship-assembly-totals';
import { validateShipAssembly } from './ship-assembly-validation';
import {
  copyTransform, isIdentityRotation, normalizedTransform, sideMountTransform,
  sideSlotFromTransform,
} from './ship-assembly-transform';

export { isDockingModule, SIDE_SLOTS } from './ship-assembly-types';
export { sideMountTransform, sideSlotDirection } from './ship-assembly-transform';

const IDENTITY_TRANSFORM: ModuleTransform = Object.freeze({ position: v3(), rotation: Q_IDENTITY });

function connectionCopy(connection: ShipConnection): ShipConnection {
  return { ...connection, childTransform: copyTransform(connection.childTransform) };
}


// 接続グラフと module state を一体で所有し、構造操作を原子的に行う。
export class ShipAssembly {
  private readonly nodes = new Map<string, ShipAssemblyNode>();
  private readonly connections: ShipConnection[] = [];
  private nextConnectionNumber = 1;

  public constructor(
    public readonly catalog: ShipModuleCatalog = SHIP_MODULE_CATALOG,
    public readonly playerOwned = false,
  ) {}

  public get size(): number { return this.nodes.size; }

  public get moduleIds(): readonly string[] { return [...this.nodes.keys()]; }

  // 各 module の可変 state を独立した複製として返す。
  public get modules(): readonly ShipModuleInstance[] {
    return [...this.nodes.values()].map(node => cloneShipModuleInstance(node.instance));
  }

  public get graph(): readonly ShipConnection[] { return this.connections.map(connectionCopy); }

  public module(id: string): ShipModuleInstance | null {
    const node = this.nodes.get(id);
    return node === undefined ? null : cloneShipModuleInstance(node.instance);
  }

  public definition(id: string): ShipModuleDefinition | null {
    const node = this.nodes.get(id);
    return node === undefined ? null : this.catalog.get(node.instance.definitionId);
  }

  public transformOf(id: string): ModuleTransform | null {
    const node = this.nodes.get(id);
    return node === undefined ? null : copyTransform(node.transform);
  }

  public addModule(
    instance: ShipModuleInstance, parentId?: string, transform?: ModuleTransform,
    kind: ConnectionKind = 'axial', connectionId?: string, sideSlot?: SideSlot,
    sideReversed?: boolean,
  ): void {
    if (this.nodes.has(instance.id)) throw new Error(`duplicate ship module instance: ${instance.id}`);
    const definition = this.catalog.get(instance.definitionId);
    if (definition === null) throw new Error(`unknown ship module definition: ${instance.definitionId}`);
    if (definition.kind !== instance.kind) throw new Error(`module kind mismatch: ${instance.id}`);
    const childTransform = normalizedTransform(transform ?? IDENTITY_TRANSFORM);
    if (parentId === undefined) {
      if (this.nodes.size > 0) {
        const tail = this.tailId();
        if (tail !== null) parentId = tail;
      }
    }
    if (parentId === undefined) {
      if (!isIdentityRotation(childTransform.rotation)
        || childTransform.position.x !== 0 || childTransform.position.y !== 0 || childTransform.position.z !== 0) {
        throw new Error('root module must use the identity transform');
      }
    } else {
      const parent = this.nodes.get(parentId);
      if (parent === undefined) throw new Error(`unknown parent module: ${parentId}`);
      if (this.connections.some(connection => connection.childId === instance.id)) {
        throw new Error(`module already connected: ${instance.id}`);
      }
      const id = connectionId ?? `connection-${this.nextConnectionNumber}`;
      if (this.connections.some(connection => connection.id === id)) throw new Error(`duplicate connection: ${id}`);
    }
    if (parentId !== undefined) {
      const id = connectionId ?? `connection-${this.nextConnectionNumber++}`;
      if (connectionId !== undefined) this.nextConnectionNumber++;
      const resolvedSideSlot = kind === 'side'
        ? (sideReversed ? sideSlot : (sideSlot ?? sideSlotFromTransform(childTransform)))
        : undefined;
      if (kind === 'side' && resolvedSideSlot == null) throw new Error(`side connection needs a valid side slot: ${instance.id}`);
      this.nodes.set(instance.id, { instance: cloneShipModuleInstance(instance), transform: childTransform });
      this.connections.push({
        id, parentId, childId: instance.id, kind, childTransform: copyTransform(childTransform),
        ...(resolvedSideSlot == null ? {} : { sideSlot: resolvedSideSlot }),
        ...(sideReversed ? { sideReversed: true } : {}),
      });
    } else {
      this.nodes.set(instance.id, { instance: cloneShipModuleInstance(instance), transform: childTransform });
    }
  }

  public addRoot(instance: ShipModuleInstance): void { this.addModule(instance); }

  // -Z（船尾）方向へ端面どうしを一致させる直列追加。端面の間隔は常に 0。
  public append(instance: ShipModuleInstance, parentId?: string): void {
    const resolvedParentId = parentId ?? this.tailId();
    const parent = resolvedParentId === null ? undefined : this.nodes.get(resolvedParentId);
    if (parent === undefined) {
      this.addModule(instance);
      return;
    }
    const parentDefinition = this.catalog.require(parent.instance.definitionId);
    const childDefinition = this.catalog.require(instance.definitionId);
    this.addModule(instance, parent.instance.id, {
      position: v3(0, 0, -(parentDefinition.length / 2 + childDefinition.length / 2)),
      rotation: Q_IDENTITY,
    }, 'axial');
  }

  // +Z（船首）方向へ端面どうしを一致させる直列追加。端面の間隔は常に 0。
  public prepend(instance: ShipModuleInstance, parentId?: string): void {
    const resolvedParentId = parentId ?? this.headId();
    const parent = resolvedParentId === null ? undefined : this.nodes.get(resolvedParentId);
    if (parent === undefined) {
      this.addModule(instance);
      return;
    }
    const parentDefinition = this.catalog.require(parent.instance.definitionId);
    const childDefinition = this.catalog.require(instance.definitionId);
    this.addModule(instance, parent.instance.id, {
      position: v3(0, 0, parentDefinition.length / 2 + childDefinition.length / 2),
      rotation: Q_IDENTITY,
    }, 'axial');
  }

  // 明示 transform で module を側面接続する。
  public connectSide(
    instance: ShipModuleInstance, parentId: string, transformOrSlot: ModuleTransform | SideSlot, connectionId?: string,
  ): void {
    const parent = this.nodes.get(parentId);
    if (parent === undefined) throw new Error(`unknown parent module: ${parentId}`);
    const child = this.catalog.require(instance.definitionId);
    const parentDefinition = this.catalog.require(parent.instance.definitionId);
    const sideSlot = typeof transformOrSlot === 'string' ? transformOrSlot : sideSlotFromTransform(transformOrSlot);
    if (sideSlot === null) throw new Error(`side connection needs a valid side slot: ${instance.id}`);
    const transform = typeof transformOrSlot === 'string'
      ? sideMountTransform(parentDefinition, child, transformOrSlot) : transformOrSlot;
    this.addModule(instance, parentId, transform, 'side', connectionId, sideSlot);
  }

  // 建造枝の根元を、ポート対の docking edge とは別の分離可能な建造接続へ確定する。
  public completeConstructionConnection(connectionId: string): void {
    const index = this.connections.findIndex(connection => connection.id === connectionId);
    const connection = index < 0 ? undefined : this.connections[index];
    if (connection === undefined) throw new Error(`unknown construction connection: ${connectionId}`);
    if (connection.kind === 'construction') return;
    if (connection.kind === 'docking') throw new Error(`docking connection is not a construction branch: ${connectionId}`);
    if (this.nodes.get(connection.parentId)?.instance.kind !== 'dock') {
      throw new Error(`construction connection does not start at a docking module: ${connectionId}`);
    }
    this.connections[index] = { ...connection, kind: 'construction' };
  }

  /** 二つの接舷部を正対させ、other をこの assembly の dock branch として複製統合する。 */
  public mergedAtDock(
    other: ShipAssembly, localPortId: string, otherPortId: string, namespace: string,
  ): DockingMergeResult {
    if (other === this) throw new Error('cannot dock an assembly to itself');
    if (other.catalog !== this.catalog) throw new Error('cannot dock assemblies from different catalogs');
    this.assertValid();
    other.assertValid();
    const localPort = this.module(localPortId);
    const otherPort = other.module(otherPortId);
    if (!isDockingModule(localPort) || !isDockingModule(otherPort)) throw new Error('docking requires two ports');
    if (localPort.hp <= 0 || otherPort.hp <= 0) throw new Error('docking port is destroyed');
    if (this.isPortConnected(localPortId) || other.isPortConnected(otherPortId)) {
      throw new Error('docking port is already occupied');
    }

    const merged = this.clone();
    const moduleIds = new Map<string, string>();
    const connectionIds = new Map<string, string>();
    const reservedModuleIds = new Set(merged.moduleIds);
    for (const id of other.moduleIds) {
      let candidate = id;
      let suffix = 2;
      while (reservedModuleIds.has(candidate)) {
        candidate = `${namespace}:${id}${suffix === 2 ? '' : `-${suffix}`}`;
        suffix++;
      }
      moduleIds.set(id, candidate);
      reservedModuleIds.add(candidate);
    }

    const otherWorld = new Map<string, ModuleTransform>();
    for (const id of other.moduleIds) {
      const transform = other.worldTransformOf(id);
      if (transform === null) throw new Error(`missing module transform: ${id}`);
      otherWorld.set(id, transform);
    }
    const visited = new Set<string>();
    const pending: { readonly id: string; readonly parentId: string | null; readonly sourceEdge: ShipConnection | null }[] = [
      { id: otherPortId, parentId: null, sourceEdge: null },
    ];
    const dockRotation = qFromAxisAngle(LOCAL_UP, Math.PI);
    const localDefinition = this.catalog.require(localPort.definitionId);
    const otherDefinition = this.catalog.require(otherPort.definitionId);
    const mappedOtherPortId = moduleIds.get(otherPortId);
    if (mappedOtherPortId === undefined) throw new Error(`missing mapped docking port: ${otherPortId}`);
    const dockingConnectionId = merged.uniqueConnectionId(`docking-${localPortId}-${mappedOtherPortId}`);
    while (pending.length > 0) {
      const current = pending.shift();
      if (current === undefined) break;
      if (visited.has(current.id)) continue;
      visited.add(current.id);
      const sourceInstance = other.module(current.id);
      const mappedId = moduleIds.get(current.id);
      if (sourceInstance === null || mappedId === undefined) throw new Error(`missing docked module: ${current.id}`);
      const instance = { ...sourceInstance, id: mappedId } as ShipModuleInstance;
      if (current.parentId === null) {
        merged.addModule(instance, localPortId, {
          position: v3(0, 0, (localDefinition.length + otherDefinition.length) / 2),
          rotation: dockRotation,
        }, 'docking', dockingConnectionId);
      } else {
        const sourceEdge = current.sourceEdge;
        const parentWorld = otherWorld.get(current.parentId);
        const childWorld = otherWorld.get(current.id);
        const mappedParentId = moduleIds.get(current.parentId);
        if (sourceEdge === null || parentWorld === undefined || childWorld === undefined
          || mappedParentId === undefined) throw new Error(`invalid docked branch: ${current.id}`);
        const inverse = qInvert(parentWorld.rotation);
        const relative: ModuleTransform = {
          position: qRotate(inverse, v3(
            childWorld.position.x - parentWorld.position.x,
            childWorld.position.y - parentWorld.position.y,
            childWorld.position.z - parentWorld.position.z,
          )),
          rotation: qMul(inverse, childWorld.rotation),
        };
        const edgeId = merged.uniqueConnectionId(sourceEdge.id);
        connectionIds.set(sourceEdge.id, edgeId);
        const isTraversingBackwards = sourceEdge.parentId === current.id;
        const isSide = sourceEdge.kind === 'side';
        const sideReversed = isSide
          ? (isTraversingBackwards ? !sourceEdge.sideReversed : (sourceEdge.sideReversed ?? false))
          : undefined;
        const sideSlot = isSide ? sourceEdge.sideSlot : undefined;
        merged.addModule(
          instance, mappedParentId, relative, sourceEdge.kind, edgeId, sideSlot, sideReversed,
        );
      }
      for (const edge of other.connections) {
        const neighbor = edge.parentId === current.id ? edge.childId
          : edge.childId === current.id ? edge.parentId : null;
        if (neighbor !== null && !visited.has(neighbor)) {
          pending.push({ id: neighbor, parentId: current.id, sourceEdge: edge });
        }
      }
    }
    merged.assertValid();
    if (visited.size !== other.moduleIds.length) throw new Error('docked assembly graph is disconnected');
    return { assembly: merged, connectionId: dockingConnectionId, moduleIds, connectionIds };
  }

  public dockingConnections(): readonly ShipConnection[] {
    return this.graph.filter(connection => connection.kind === 'docking');
  }

  public constructionConnections(): readonly ShipConnection[] {
    return this.graph.filter(connection => connection.kind === 'construction');
  }

  public detachableConnections(): readonly ShipConnection[] {
    return this.graph.filter(connection => connection.kind === 'docking' || connection.kind === 'construction');
  }

  public isDockingPortOccupied(moduleId: string): boolean {
    return this.connections.some(connection => connection.kind === 'docking'
      && (connection.parentId === moduleId || connection.childId === moduleId));
  }

  public isPortConnected(moduleId: string): boolean {
    return this.connections.some(connection => (connection.kind === 'docking' || connection.kind === 'construction')
      && (connection.parentId === moduleId || connection.childId === moduleId));
  }

  private uniqueConnectionId(preferred: string): string {
    let candidate = preferred;
    let suffix = 2;
    while (this.connections.some(connection => connection.id === candidate)) {
      candidate = `${preferred}-${suffix++}`;
    }
    return candidate;
  }

  public removeModule(id: string): ShipModuleInstance | null {
    const node = this.nodes.get(id);
    if (node === undefined) return null;
    if (this.connections.some(connection => connection.parentId === id)) {
      throw new Error(`cannot remove module with children: ${id}`);
    }
    this.nodes.delete(id);
    for (let i = this.connections.length - 1; i >= 0; i--) {
      const connection = this.connections[i];
      if (connection?.childId === id) this.connections.splice(i, 1);
    }
    return cloneShipModuleInstance(node.instance);
  }

  // 建造枝の自由端から一つ撤去する。最後に追加された leaf を選ぶので、side branch は保つ。
  public removeTail(): ShipModuleInstance | null {
    const id = this.tailId();
    return id === null ? null : this.removeModule(id);
  }

  public tailId(): string | null {
    for (const id of [...this.nodes.keys()].reverse()) {
      if (this.connections.some(c => c.parentId === id && c.kind === 'axial' && c.childTransform.position.z <= 0)) continue;
      const incoming = this.connections.find(c => c.childId === id);
      if (incoming === undefined || (incoming.kind === 'axial' && incoming.childTransform.position.z <= 0)) return id;
    }
    return null;
  }

  public headId(): string | null {
    for (const id of [...this.nodes.keys()].reverse()) {
      if (this.connections.some(c => c.parentId === id && c.kind === 'axial' && c.childTransform.position.z >= 0)) continue;
      const incoming = this.connections.find(c => c.childId === id);
      if (incoming === undefined || (incoming.kind === 'axial' && incoming.childTransform.position.z >= 0)) return id;
    }
    return null;
  }

  public totals(): ShipAssemblyTotals {
    return shipAssemblyTotals(this.nodes, this.catalog);
  }

  public get totalHp(): number { return this.totals().hp; }
  public get maxHp(): number { return this.totals().maxHp; }
  public get totalThrust(): number { return this.totals().thrust; }
  public get totalTorque(): number { return this.totals().torque; }
  public get totalFuel(): number {
    const t = this.totals();
    return t.mainFuel + t.rcsFuel + t.boosterFuel;
  }
  public get totalDryMass(): number { return this.totals().dryMass; }
  public get totalMass(): number { return this.totals().mass; }
  public get totalPower(): number { return this.totals().power; }
  public get totalRadiation(): number { return this.totals().radiation; }
  public get totalWeaponDamage(): number { return this.totals().weaponDamage; }

  public consumeFuel(kind: 'main' | 'rcs', amount: number): number {
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    let remaining = amount;
    for (const node of this.nodes.values()) {
      if (remaining <= 0 || node.instance.hp <= 0) continue;
      if (node.instance.kind === 'tank' && node.instance.fuelKind === kind) {
        const used = Math.min(node.instance.fuel, remaining);
        node.instance.fuel -= used;
        remaining -= used;
      }
    }
    return amount - remaining;
  }

  public refuel(kind: 'main' | 'rcs', amount: number): number {
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    let remaining = amount;
    for (const node of this.nodes.values()) {
      if (remaining <= 0 || node.instance.hp <= 0) continue;
      const definition = this.catalog.require(node.instance.definitionId);
      const capacity = definition.abilities.fuelCapacity ?? 0;
      if (node.instance.kind === 'tank' && node.instance.fuelKind === kind) {
        const added = Math.min(capacity - node.instance.fuel, remaining);
        node.instance.fuel += Math.max(0, added);
        remaining -= Math.max(0, added);
      }
    }
    return amount - remaining;
  }

  public setIgnited(id: string, ignited: boolean): void {
    const node = this.nodes.get(id);
    if (node?.instance.kind !== 'booster') throw new Error(`not a booster module: ${id}`);
    node.instance.ignited = ignited && node.instance.fuel > 0 && node.instance.hp > 0;
  }

  public consumeBoosterFuel(id: string, amount: number): number {
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    const node = this.nodes.get(id);
    if (node?.instance.kind !== 'booster') throw new Error(`not a booster module: ${id}`);
    if (node.instance.hp <= 0 || !node.instance.ignited) return 0;
    const consumed = Math.min(node.instance.fuel, amount);
    node.instance.fuel -= consumed;
    if (node.instance.fuel <= 0) node.instance.ignited = false;
    return consumed;
  }

  public setDeployment(id: string, deployed: number): void {
    const node = this.nodes.get(id);
    if (node?.instance.kind !== 'radiator' && node?.instance.kind !== 'solar_panel') {
      throw new Error(`not a deployable module: ${id}`);
    }
    if (!Number.isFinite(deployed)) throw new Error(`deployment must be finite: ${id}`);
    node.instance.deployed = Math.max(0, Math.min(1, deployed));
  }

  public setTemperature(id: string, temperature: number): void {
    const node = this.nodes.get(id);
    if (node === undefined) throw new Error(`unknown module: ${id}`);
    if (!Number.isFinite(temperature) || temperature < 0) throw new Error(`temperature must be finite: ${id}`);
    node.instance.temperature = temperature;
  }

  // 修理・復元・構造操作が module の耐久値を明示的に揃える入口。
  public setHp(id: string, hp: number): void {
    const node = this.nodes.get(id);
    if (node === undefined) throw new Error(`unknown module: ${id}`);
    if (!Number.isFinite(hp)) throw new Error(`module hp must be finite: ${id}`);
    const maxHp = this.catalog.require(node.instance.definitionId).maxHp;
    node.instance.hp = Math.max(0, Math.min(maxHp, hp));
  }

  public get role(): ShipRole {
    const healthy = (kind: ShipModuleInstance['kind']): boolean => [...this.nodes.values()]
      .some(node => node.instance.kind === kind && node.instance.hp > 0);
    if (!healthy('cockpit')) return 'material';
    return healthy('dock') ? 'base' : 'ship';
  }

  public validate(): ShipAssemblyValidation {
    return validateShipAssembly(this.nodes, this.connections, this.catalog);
  }

  public assertValid(): void {
    const result = this.validate();
    if (!result.valid) throw new Error(`invalid ship assembly: ${result.errors.join('; ')}`);
  }

  // 健全 module から seed 固定で標的を選ぶ。展開中 radiator への直撃は damage を 0.25 倍する。
  public damage(amount: number, seed: number, targetModuleId: string | null = null): string | null {
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const target = targetModuleId === null ? null : this.nodes.get(targetModuleId);
    let targetNode = target;
    let effectiveAmount = amount;
    if (targetNode?.instance.kind === 'radiator' && targetNode.instance.hp > 0 && targetNode.instance.deployed > 0) {
      effectiveAmount *= 0.25;
    } else {
      const healthy = [...this.nodes.values()].filter(node => node.instance.hp > 0);
      if (healthy.length === 0) return null;
      targetNode = healthy[Math.floor(mulberry32(seed)() * healthy.length)];
    }
    if (targetNode === undefined) return null;
    let reduction = 0;
    for (const node of this.nodes.values()) {
      if (node.instance.kind !== 'armor' || node.instance.hp <= 0) continue;
      reduction = Math.max(reduction, this.catalog.require(node.instance.definitionId).abilities.armorReduction ?? 0);
    }
    targetNode.instance.hp = Math.max(0, targetNode.instance.hp - effectiveAmount * (1 - reduction));
    return targetNode.instance.id;
  }

  public clone(): ShipAssembly {
    return ShipAssembly.fromInternal(this.catalog, this.nodes, this.connections, this.nextConnectionNumber, this.playerOwned);
  }

  // 切断 edge の子側を新しい root として正規化し、元の instance を左右へ排他的に移管する。
  // この assembly は split 後に消費済みとなり、clone による三者共有を作らない。
  public splitAt(connectionId: string): readonly [ShipAssembly, ShipAssembly] {
    const edge = this.connections.find(connection => connection.id === connectionId);
    if (edge === undefined) throw new Error(`unknown connection: ${connectionId}`);
    const leftIds = this.component(edge.parentId, connectionId);
    const rightIds = new Set([...this.nodes.keys()].filter(id => !leftIds.has(id)));
    const left = this.transferAssembly(leftIds);
    const right = this.transferAssembly(rightIds);
    this.nodes.clear();
    this.connections.length = 0;
    return [left, right];
  }

  // この assembly の同一性を保って source の構成を移管する。source は消費済みになる。
  public replaceWith(source: ShipAssembly): void {
    if (source === this) return;
    if (source.catalog !== this.catalog) throw new Error('cannot replace assembly from a different catalog');
    if (source.nodes.size === 0) throw new Error('cannot replace assembly with an empty assembly');
    this.nodes.clear();
    this.connections.length = 0;
    for (const [id, node] of source.nodes) this.nodes.set(id, node);
    this.connections.push(...source.connections.map(connectionCopy));
    this.nextConnectionNumber = source.nextConnectionNumber;
    source.nodes.clear();
    source.connections.length = 0;
  }

  private component(start: string, excludedEdge: string): Set<string> {
    const result = new Set<string>(), pending = [start];
    while (pending.length > 0) {
      const id = pending.pop();
      if (id === undefined) break;
      if (result.has(id)) continue;
      result.add(id);
      for (const edge of this.connections) {
        if (edge.id === excludedEdge) continue;
        if (edge.parentId === id) pending.push(edge.childId);
        else if (edge.childId === id) pending.push(edge.parentId);
      }
    }
    return result;
  }

  private transferAssembly(ids: Set<string>): ShipAssembly {
    const nodes = new Map<string, AssemblyNode>();
    for (const id of this.nodes.keys()) {
      if (!ids.has(id)) continue;
      const node = this.nodes.get(id);
      if (node !== undefined) nodes.set(id, node);
    }
    const edges = this.connections.filter(edge => ids.has(edge.parentId) && ids.has(edge.childId)).map(connectionCopy);
    const root = [...ids].find(id => !edges.some(edge => edge.childId === id));
    const rootNode = root === undefined ? undefined : nodes.get(root);
    if (rootNode !== undefined) rootNode.transform = copyTransform(IDENTITY_TRANSFORM);
    return ShipAssembly.fromTransferred(this.catalog, nodes, edges, this.nextConnectionNumber, this.playerOwned);
  }

  private static fromInternal(
    catalog: ShipModuleCatalog, nodes: Map<string, AssemblyNode>, connections: readonly ShipConnection[], next: number,
    playerOwned: boolean,
  ): ShipAssembly {
    const assembly = new ShipAssembly(catalog, playerOwned);
    for (const [id, node] of nodes) assembly.nodes.set(id, { instance: cloneShipModuleInstance(node.instance), transform: copyTransform(node.transform) });
    assembly.connections.push(...connections.map(connectionCopy));
    assembly.nextConnectionNumber = next;
    return assembly;
  }

  private static fromTransferred(
    catalog: ShipModuleCatalog, nodes: Map<string, AssemblyNode>, connections: readonly ShipConnection[], next: number,
    playerOwned: boolean,
  ): ShipAssembly {
    const assembly = new ShipAssembly(catalog, playerOwned);
    for (const [id, node] of nodes) assembly.nodes.set(id, node);
    assembly.connections.push(...connections.map(connectionCopy));
    assembly.nextConnectionNumber = next;
    return assembly;
  }

  // 子 module の transform を親 local frame から assembly frame へ展開する。
  public worldTransformOf(id: string): ModuleTransform | null {
    const node = this.nodes.get(id);
    if (node === undefined) return null;
    const parentOf = this.connections.find(connection => connection.childId === id);
    if (parentOf === undefined) return copyTransform(node.transform);
    const parent = this.worldTransformOf(parentOf.parentId);
    if (parent === null) return null;
    const local = node.transform;
    return {
      position: add(parent.position, qRotate(parent.rotation, local.position)),
      rotation: qMul(parent.rotation, local.rotation),
    };
  }

  public localTransformOfWorld(position: Vec3, rotation: Quat, parentId: string): ModuleTransform {
    const parent = this.worldTransformOf(parentId);
    if (parent === null) throw new Error(`unknown parent module: ${parentId}`);
    const inverse = qInvert(parent.rotation);
    return { position: qRotate(inverse, v3(position.x - parent.position.x, position.y - parent.position.y, position.z - parent.position.z)), rotation: qMul(inverse, rotation) };
  }
}
