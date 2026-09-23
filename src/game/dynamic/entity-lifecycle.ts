// DynamicSystem がエンティティの集合管理とライフサイクルを委譲するためのゲーム側ポート。生成済み個体の
// 所有や表示資源の具体的な実装はここへ持ち込まず、追加・pending spawn・死亡・除去の順序を
// 名前付きの境界として表す。

import type { DynamicEntity } from './dynamic-entity/dynamic-entity';
import type * as THREE from 'three/webgpu';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { DynamicMotion } from './dynamic-motion';
import type { EntityRegistry, SpawnGate, SpawnRecord } from './entity-registry';
import { EntityIdAllocators } from './dynamic-entity/entity-id';
import type { SerializedDynamicEntity } from './dynamic-entity/entity-dictionary';
import { findEntityClass } from './dynamic-entity/entity-dictionary';
import { isSerializedEnemy } from './dynamic-entity/enemy';
import { ProteinEnemy } from './dynamic-entity/protein-enemy';
import { proteinAssetGate } from '../protein/protein-asset-loader';
import { ENTITY_CAP, type CapKind } from './dynamic-entity/entity-kind';
import type { StageOutcome } from '../stages/stage-outcome';
import type { EngagementParticipant, EngagementZone } from './engagement-zone';
import type { DynamicSimulationRoster, SimulationLifecycle } from './dynamic-simulation-participant';
import { isControllable, type Controllable } from './dynamic-entity/controllable';

// pending spawn が実体化可能かを判定する条件関数。待機理由は本関数の判定外にカプセル化する。
export type EntitySpawnGate = () => boolean;

// pending spawn 一件の内容。汎用 Options/Params ではなく、生成順序に必要な値だけを持つ。
export interface PendingEntitySpawn {
  readonly gate: EntitySpawnGate;
  readonly build: () => DynamicEntity;
  readonly onSpawned?: () => void;
}

// 追加を担当する named port。
export interface EntityAdditionPort {
  add(entity: DynamicEntity): void;
}

// pending spawn の待機と処理を担当する named port。
export interface PendingEntitySpawnPort {
  queuePendingSpawn(spawn: PendingEntitySpawn): void;
  processPendingSpawns(): void;
}

// 死亡をエンティティ一覧からの除去へ進める前の境界。死亡判定そのものは DynamicEntity/Motion が持つ。
export interface EntityDeathPort {
  markDead(entity: DynamicEntity): void;
}

// 除去と所有資源の解放を担当する named port。
export interface EntityRemovalPort {
  remove(entity: DynamicEntity): void;
}

// DynamicSystem が後続配線で実装を委譲できる寿命ポート。メソッド順が一体の寿命の流れを示す。
export interface EntityLifecyclePort
  extends EntityAdditionPort, PendingEntitySpawnPort, EntityDeathPort, EntityRemovalPort {}

function readyToSpawn(record: SpawnRecord): boolean {
  const gate: SpawnGate | null = record.kind === 'protein-enemy'
    ? proteinAssetGate(record.request.assetId)
    : findEntityClass(record.entity.kind)?.spawnGate(record.entity) ?? null;
  return gate === null || gate();
}

function isEnemyRecord(record: SpawnRecord): boolean {
  return record.kind === 'protein-enemy' || isSerializedEnemy(record.entity);
}

// DynamicSystem からエンティティの collection、pending spawn、上限、回収を分離した所有者。
// Simulator へは roster/lifecycle、生成側へは registry として同じインスタンスを渡す。
export class EntityLifecycle implements EntityLifecyclePort, EntityRegistry, DynamicSimulationRoster, SimulationLifecycle {
  private readonly entities: DynamicEntity[] = [];
  private readonly pendingSpawns: SpawnRecord[] = [];
  private readonly deferredSpawns: PendingEntitySpawn[] = [];
  private collectionRevisionValue = 0;
  private capsUncheckedSinceAdd = false;
  // collectionRevision が同じ間は、全個体から導く読み取り専用の一覧も同じ内容になる。
  // hot path から map/filter の一時配列を追い出すため、同じ世代では配列実体ごと使い回す。
  private derivedCollectionRevision = -1;
  private motionCache: readonly DynamicMotion[] = [];
  private controllableCache: readonly Controllable[] = [];

  public constructor(
    private readonly scene: THREE.Scene,
    public readonly events: EntityRegistry['events'],
    private readonly celestialBodies: CelestialBodies,
    public readonly idAllocators: EntityIdAllocators = new EntityIdAllocators(),
    records: readonly SpawnRecord[] = [],
  ) {
    for (const record of records) this.spawnWhenReady(record);
  }

  public get collectionRevision(): number { return this.collectionRevisionValue; }

  public get controllables(): readonly Controllable[] {
    this.refreshDerivedCollections();
    return this.controllableCache;
  }

  public get pendingEnemyCount(): number {
    let count = 0;
    for (const record of this.pendingSpawns) {
      if (isEnemyRecord(record)) count++;
    }
    return count;
  }

  public all(): readonly DynamicEntity[] { return this.entities; }

  public allMotions(): readonly DynamicMotion[] {
    this.refreshDerivedCollections();
    return this.motionCache;
  }

  public add(entity: DynamicEntity): void {
    this.entities.push(entity);
    if (entity.capKind !== null) this.capsUncheckedSinceAdd = true;
    this.bumpCollectionRevision();
  }

  public queuePendingSpawn(spawn: PendingEntitySpawn): void {
    if (spawn.gate()) {
      const entity = spawn.build();
      this.add(entity);
      spawn.onSpawned?.();
      return;
    }
    this.deferredSpawns.push(spawn);
  }

  public spawnWhenReady(record: SpawnRecord): void {
    if (readyToSpawn(record)) this.materialize(record);
    else this.pendingSpawns.push(record);
  }

  public processPendingSpawns(): void {
    let deferredWrite = 0;
    for (const spawn of this.deferredSpawns) {
      if (spawn.gate()) {
        this.add(spawn.build());
        spawn.onSpawned?.();
      } else {
        this.deferredSpawns[deferredWrite++] = spawn;
      }
    }
    this.deferredSpawns.length = deferredWrite;
    if (this.pendingSpawns.length === 0) return;
    let w = 0;
    for (const record of this.pendingSpawns) {
      if (readyToSpawn(record)) this.materialize(record);
      else this.pendingSpawns[w++] = record;
    }
    this.pendingSpawns.length = w;
  }

  public markDead(entity: DynamicEntity): void { entity.motion.kill(); }

  public remove(entity: DynamicEntity): void {
    if (!this.detach(entity)) return;
    entity.dispose();
  }

  public requestHistoryDuration(sec: number): void {
    for (const entity of this.entities) entity.motion.requestHistoryDuration(sec);
  }

  public serializedEntities(): readonly SerializedDynamicEntity[] {
    return this.entities.map(entity => entity.serialize());
  }

  public pendingSpawnRecords(): readonly SpawnRecord[] { return this.pendingSpawns; }

  public cleanup(
    _dt: number, _simTime: number, activeStage: StageOutcome,
    zones: readonly EngagementZone<EngagementParticipant>[],
  ): void {
    this.processPendingSpawns();
    const atmosphereBodies = this.celestialBodies.atmosphereMotions;
    const currentEntities = this.entities.length;
    for (let i = 0; i < currentEntities; i++) {
      this.entities[i]!.motion.checkLoss(
        _dt, _simTime, { activeStage, registry: this }, zones, atmosphereBodies,
      );
    }
    this.enforceCaps();
    this.prune();
  }

  public dispose(): void {
    for (const entity of this.entities) entity.dispose();
    this.entities.length = 0;
    this.pendingSpawns.length = 0;
    this.bumpCollectionRevision();
  }

  private materialize(record: SpawnRecord): void {
    if (record.kind === 'protein-enemy') {
      this.add(ProteinEnemy.create(record.request, this.idAllocators, this.scene));
      return;
    }
    const entityClass = findEntityClass(record.entity.kind);
    if (entityClass !== null) this.add(entityClass.deserialize(record.entity, this, this.scene));
  }

  private detach(entity: DynamicEntity): boolean {
    const index = this.entities.indexOf(entity);
    if (index < 0) return false;
    this.entities.splice(index, 1);
    this.bumpCollectionRevision();
    return true;
  }

  private enforceCaps(): void {
    if (!this.capsUncheckedSinceAdd) return;
    this.capsUncheckedSinceAdd = false;
    const live: Record<CapKind, number> = { bullet: 0, casing: 0, debris: 0 };
    for (let i = this.entities.length - 1; i >= 0; i--) {
      const entity = this.entities[i]!;
      const cap = entity.capKind;
      if (cap === null || !entity.motion.alive) continue;
      const rank = live[cap] + 1;
      live[cap] = rank;
      if (rank > ENTITY_CAP[cap]) entity.motion.kill();
    }
  }

  private prune(): void {
    let write = 0;
    let changed = false;
    for (const entity of this.entities) {
      if (!entity.motion.alive && !entity.reclaimedByOwner) {
        entity.dispose();
        changed = true;
      } else {
        this.entities[write++] = entity;
      }
    }
    this.entities.length = write;
    if (changed) this.bumpCollectionRevision();
  }

  // エンティティ集合からだけ決まる派生一覧を、世代が変わったときに1回だけ作り直す。
  // 同じ世代では配列を使い回す一方、世代が変わったら新しい snapshot にする — 以前の allMotions()/
  // controllables の返り値を保持している読み手まで、後から別の集合へ書き換わらないため。
  // alive の変化だけでは集合は変わらないため、従来どおり死亡個体も prune まで一覧に残る。
  private refreshDerivedCollections(): void {
    if (this.derivedCollectionRevision === this.collectionRevisionValue) return;
    const motions: DynamicMotion[] = [];
    const controllables: Controllable[] = [];
    for (const entity of this.entities) {
      motions.push(entity.motion);
      if (isControllable(entity)) controllables.push(entity);
    }
    this.motionCache = motions;
    this.controllableCache = controllables;
    this.derivedCollectionRevision = this.collectionRevisionValue;
  }

  private bumpCollectionRevision(): void { this.collectionRevisionValue++; }
}
