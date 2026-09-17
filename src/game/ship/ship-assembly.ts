import { mulberry32 } from '../../math/random';
import {
  LOCAL_RIGHT, Q_IDENTITY, qFromAxisAngle, qInvert, qMul, qNormalize, qRotate, type Quat,
} from '../../math/quat';
import { add, v3, type Vec3 } from '../../math/vec3';
import {
  SHIP_MODULE_CATALOG, type ShipModuleCatalog,
} from './ship-module-catalog';
import type { ShipModuleDefinition } from './ship-module-definition';
import { cloneShipModuleInstance, type ShipModuleInstance } from './ship-module-instance';

export type ShipRole = 'ship' | 'base' | 'material';
export type ConnectionKind = 'axial' | 'side' | 'docking';

export interface ModuleTransform {
  readonly position: Vec3;
  readonly rotation: Quat;
}

export interface ShipConnection {
  readonly id: string;
  readonly parentId: string;
  readonly childId: string;
  readonly kind: ConnectionKind;
  readonly childTransform: ModuleTransform;
}

export interface ShipAssemblyValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export interface DockingMergeResult {
  readonly assembly: ShipAssembly;
  readonly connectionId: string;
  readonly moduleIds: ReadonlyMap<string, string>;
  readonly connectionIds: ReadonlyMap<string, string>;
}

export interface ShipAssemblyTotals {
  readonly hp: number;
  readonly maxHp: number;
  readonly thrust: number;
  readonly torque: number;
  readonly mainFuel: number;
  readonly rcsFuel: number;
  readonly boosterFuel: number;
  readonly maxMainFuel: number;
  readonly maxRcsFuel: number;
  readonly maxBoosterFuel: number;
  readonly power: number;
  readonly radiation: number;
  readonly weaponDamage: number;
  readonly fireRate: number;
  readonly muzzleVelocity: number;
  readonly dryMass: number;
  readonly mass: number;
}

interface AssemblyNode {
  instance: ShipModuleInstance;
  transform: ModuleTransform;
}

const IDENTITY_TRANSFORM: ModuleTransform = Object.freeze({ position: v3(), rotation: Q_IDENTITY });

function copyTransform(transform: ModuleTransform): ModuleTransform {
  return { position: v3(transform.position.x, transform.position.y, transform.position.z), rotation: { ...transform.rotation } };
}

function normalizedTransform(transform: ModuleTransform): ModuleTransform {
  if (!finiteVector(transform.position) || !finiteQuaternion(transform.rotation)) {
    throw new Error('module transform must be finite');
  }
  const length = Math.hypot(transform.rotation.x, transform.rotation.y, transform.rotation.z, transform.rotation.w);
  if (!(length > 1e-12)) throw new Error('module transform rotation must be nonzero');
  return {
    position: v3(transform.position.x, transform.position.y, transform.position.z),
    rotation: qNormalize(transform.rotation),
  };
}

function finiteVector(value: Vec3): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function finiteQuaternion(value: Quat): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y)
    && Number.isFinite(value.z) && Number.isFinite(value.w);
}

function isIdentityRotation(value: Quat): boolean {
  return value.x === 0 && value.y === 0 && value.z === 0 && value.w === 1;
}

function connectionCopy(connection: ShipConnection): ShipConnection {
  return { ...connection, childTransform: copyTransform(connection.childTransform) };
}

function isDockModule(
  module: ShipModuleInstance | null,
): module is ShipModuleInstance & { readonly kind: 'dock' | 'docking_port' } {
  return module?.kind === 'dock' || module?.kind === 'docking_port';
}

// 接続グラフと module state を一体で所有する純粋な船体ドメイン。THREE や DynamicMotion は知らない。
export class ShipAssembly {
  private readonly nodes = new Map<string, AssemblyNode>();
  private readonly connections: ShipConnection[] = [];
  private nextConnectionNumber = 1;

  public constructor(
    public readonly catalog: ShipModuleCatalog = SHIP_MODULE_CATALOG,
    public readonly playerOwned = false,
  ) {}

  public get size(): number { return this.nodes.size; }

  public get moduleIds(): readonly string[] { return [...this.nodes.keys()]; }

  // 外部へ内部の可変 state を露出しない。編集は damage/remove/instanceState API を通す。
  public get modules(): readonly ShipModuleInstance[] {
    return [...this.nodes.values()].map(node => cloneShipModuleInstance(node.instance));
  }

  public get instances(): readonly ShipModuleInstance[] { return this.modules; }

  public get graph(): readonly ShipConnection[] { return this.connections.map(connectionCopy); }

  public module(id: string): ShipModuleInstance | null {
    const node = this.nodes.get(id);
    return node === undefined ? null : cloneShipModuleInstance(node.instance);
  }

  public instance(id: string): ShipModuleInstance | null { return this.module(id); }

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
    kind: ConnectionKind = 'axial', connectionId?: string,
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
    this.nodes.set(instance.id, { instance: cloneShipModuleInstance(instance), transform: childTransform });
    if (parentId !== undefined) {
      const id = connectionId ?? `connection-${this.nextConnectionNumber++}`;
      if (connectionId !== undefined) this.nextConnectionNumber++;
      this.connections.push({ id, parentId, childId: instance.id, kind, childTransform: copyTransform(childTransform) });
    }
  }

  public addRoot(instance: ShipModuleInstance): void { this.addModule(instance); }

  // +Z の端面どうしを一致させる直列追加。端面の間隔は常に 0。
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
      position: v3(0, 0, parentDefinition.length / 2 + childDefinition.length / 2),
      rotation: Q_IDENTITY,
    }, 'axial');
  }

  // 側面 dock は transform を呼び出し側が明示する。自動で軸回転・位置補正はしない。
  public connectSide(
    instance: ShipModuleInstance, parentId: string, transform: ModuleTransform, connectionId?: string,
  ): void {
    this.addModule(instance, parentId, transform, 'side', connectionId);
  }

  /** 二つの接舷部を正対させ、other をこの assembly の dock branch として複製統合する。 */
  public mergedAtDock(
    other: ShipAssembly, localPortId: string, otherPortId: string, namespace: string,
  ): DockingMergeResult {
    if (other === this) throw new Error('cannot dock an assembly to itself');
    if (other.catalog !== this.catalog) throw new Error('cannot dock assemblies from different catalogs');
    const localPort = this.module(localPortId);
    const otherPort = other.module(otherPortId);
    if (!isDockModule(localPort) || !isDockModule(otherPort)) throw new Error('docking requires two ports');
    if (localPort.hp <= 0 || otherPort.hp <= 0) throw new Error('docking port is destroyed');
    if (this.isDockingPortOccupied(localPortId) || other.isDockingPortOccupied(otherPortId)) {
      throw new Error('docking port is already occupied');
    }

    const merged = this.clone();
    const moduleIds = new Map<string, string>();
    const connectionIds = new Map<string, string>();
    for (const id of other.moduleIds) {
      let candidate = id;
      let suffix = 2;
      while (merged.nodes.has(candidate) || [...moduleIds.values()].includes(candidate)) {
        candidate = `${namespace}:${id}${suffix === 2 ? '' : `-${suffix}`}`;
        suffix++;
      }
      moduleIds.set(id, candidate);
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
    const dockRotation = qFromAxisAngle(LOCAL_RIGHT, Math.PI);
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
        merged.addModule(
          instance, mappedParentId, relative, sourceEdge.kind, edgeId,
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
    return { assembly: merged, connectionId: dockingConnectionId, moduleIds, connectionIds };
  }

  public dockingConnections(): readonly ShipConnection[] {
    return this.graph.filter(connection => connection.kind === 'docking');
  }

  public isDockingPortOccupied(moduleId: string): boolean {
    return this.connections.some(connection => connection.kind === 'docking'
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

  public tailRemoval(): ShipModuleInstance | null { return this.removeTail(); }

  private tailId(): string | null {
    for (const id of [...this.nodes.keys()].reverse()) {
      if (this.connections.some(connection => connection.parentId === id)) continue;
      const incoming = this.connections.find(connection => connection.childId === id);
      if (incoming === undefined || incoming.kind === 'axial') return id;
    }
    return null;
  }

  public totals(): ShipAssemblyTotals {
    let hp = 0, maxHp = 0, thrust = 0, torque = 0, mainFuel = 0, rcsFuel = 0, boosterFuel = 0;
    let maxMainFuel = 0, maxRcsFuel = 0, maxBoosterFuel = 0, power = 0, radiation = 0, fireRate = 0;
    let weaponDamage = 0, muzzleVelocityTotal = 0, weaponCount = 0, dryMass = 0, mass = 0;
    for (const node of this.nodes.values()) {
      const definition = this.catalog.require(node.instance.definitionId);
      const abilities = definition.abilities;
      dryMass += definition.dryMass;
      mass += definition.dryMass;
      if (node.instance.kind === 'tank' || node.instance.kind === 'booster') {
        mass += node.instance.fuel * (abilities.fuelMassPerUnit ?? 1);
      }
      hp += node.instance.hp;
      maxHp += definition.maxHp;
      if (node.instance.hp <= 0) continue;
      if (node.instance.kind !== 'booster') thrust += abilities.thrust ?? 0;
      torque += abilities.torque ?? 0;
      power += abilities.powerGeneration ?? 0;
      radiation += abilities.radiationArea ?? 0;
      const capacity = abilities.fuelCapacity ?? 0;
      if (node.instance.kind === 'tank') {
        if (node.instance.fuelKind === 'main') { mainFuel += node.instance.fuel; maxMainFuel += capacity; }
        else { rcsFuel += node.instance.fuel; maxRcsFuel += capacity; }
      } else if (node.instance.kind === 'booster') {
        if (node.instance.ignited) thrust += abilities.thrust ?? 0;
        boosterFuel += node.instance.fuel;
        maxBoosterFuel += capacity;
      }
      if (node.instance.kind === 'weapon') {
        weaponDamage = Math.max(weaponDamage, abilities.weaponDamage ?? 0);
        fireRate += abilities.fireRate ?? 0;
        if (abilities.muzzleVelocity !== undefined) {
          muzzleVelocityTotal += abilities.muzzleVelocity;
          weaponCount++;
        }
      }
    }
    return {
      hp, maxHp, thrust, torque, mainFuel, rcsFuel, boosterFuel,
      maxMainFuel, maxRcsFuel, maxBoosterFuel, power, radiation,
      weaponDamage, fireRate, muzzleVelocity: weaponCount === 0 ? 0 : muzzleVelocityTotal / weaponCount,
      dryMass, mass,
    };
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
    const errors: string[] = [];
    const childIds = new Set<string>();
    const parentIds = new Set<string>();
    for (const [id, node] of this.nodes) {
      const definition = this.catalog.get(node.instance.definitionId);
      if (definition === null) errors.push(`unknown definition: ${node.instance.definitionId}`);
      else if (definition.kind !== node.instance.kind) errors.push(`kind mismatch: ${id}`);
      if (!finiteVector(node.transform.position) || !finiteQuaternion(node.transform.rotation)) {
        errors.push(`non-finite transform: ${id}`);
      }
    }
    for (const connection of this.connections) {
      if (!this.nodes.has(connection.parentId)) errors.push(`missing parent: ${connection.parentId}`);
      if (!this.nodes.has(connection.childId)) errors.push(`missing child: ${connection.childId}`);
      if (childIds.has(connection.childId)) errors.push(`multiple parents: ${connection.childId}`);
      childIds.add(connection.childId);
      if (parentIds.has(connection.id)) errors.push(`duplicate connection: ${connection.id}`);
      parentIds.add(connection.id);
      if (!finiteVector(connection.childTransform.position) || !finiteQuaternion(connection.childTransform.rotation)) {
        errors.push(`non-finite connection transform: ${connection.id}`);
      }
      const parent = this.nodes.get(connection.parentId);
      const child = this.nodes.get(connection.childId);
      if (connection.kind === 'axial' && parent !== undefined && child !== undefined) {
        const parentDef = this.catalog.get(parent.instance.definitionId);
        const childDef = this.catalog.get(child.instance.definitionId);
        const expected = (parentDef?.length ?? 0) / 2 + (childDef?.length ?? 0) / 2;
        const p = connection.childTransform.position;
        if (Math.abs(p.x) > 1e-9 || Math.abs(p.y) > 1e-9 || Math.abs(Math.abs(p.z) - expected) > 1e-9
          || !isIdentityRotation(connection.childTransform.rotation)) errors.push(`invalid axial snap: ${connection.id}`);
      }
    }
    const roots = [...this.nodes.keys()].filter(id => !childIds.has(id));
    if (this.nodes.size > 0 && roots.length !== 1) errors.push(`assembly must have one root, got ${roots.length}`);
    const visiting = new Set<string>(), visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) { errors.push(`connection cycle at: ${id}`); return; }
      if (visited.has(id)) return;
      visiting.add(id);
      for (const edge of this.connections) if (edge.parentId === id && this.nodes.has(edge.childId)) visit(edge.childId);
      visiting.delete(id); visited.add(id);
    };
    for (const root of roots) visit(root);
    if (visited.size !== this.nodes.size) errors.push('assembly graph is disconnected');
    return { valid: errors.length === 0, errors: Object.freeze(errors) };
  }

  public assertValid(): void {
    const result = this.validate();
    if (!result.valid) throw new Error(`invalid ship assembly: ${result.errors.join('; ')}`);
  }

  // 健全 module から seed 固定で一様に選ぶ。展開中の健全 radiator を target にした場合だけ、
  // 既存例外として軽減された damage をその radiator へ固定する。接続 graph は変更しない。
  public damage(amount: number, seed: number, targetModuleId?: string): string | null {
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const target = targetModuleId === undefined ? null : this.nodes.get(targetModuleId);
    let targetNode = target;
    let effectiveAmount = amount;
    if (targetNode?.instance.kind === 'radiator' && targetNode.instance.hp > 0 && targetNode.instance.deployed > 0) {
      effectiveAmount *= 0.25; // player.ts の既存 RADIATOR_BULLET_DAMAGE と同じ軽減。展開状態は変えない。
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

  public applyDamage(amount: number, seed: number, targetModuleId?: string): string | null {
    return this.damage(amount, seed, targetModuleId);
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

  public split(connectionId: string): readonly [ShipAssembly, ShipAssembly] { return this.splitAt(connectionId); }

  // Motion/View が保持する assembly オブジェクトの同一性を保ったまま、分割後の構成へ置換する。
  // source の instance は排他的に移管し、呼び出し後の source は消費済みになる。
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

  // 子 module の transform を親の local frame から world-like assembly frame へ展開する補助。
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
