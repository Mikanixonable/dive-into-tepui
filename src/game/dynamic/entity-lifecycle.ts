// 動的エンティティの集合、実体化待ち、上限管理と寿命回収を担う。

import type { DynamicEntity } from './dynamic-entity/dynamic-entity';
import type * as THREE from 'three/webgpu';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { DynamicMotion } from './dynamic-motion';
import type { EntityRegistry, SpawnGate, SpawnRecord } from './entity-registry';
import { EntityIdAllocators } from './dynamic-entity/entity-id';
import type { SerializedDynamicEntity } from './dynamic-entity/entity-dictionary';
import { findEntityClass } from './dynamic-entity/entity-dictionary';
import { isSerializedEnemy } from './dynamic-entity/enemy';
import { ENTITY_CAP, type CapKind } from './dynamic-entity/entity-kind';
import type { StageOutcome } from '../stages/stage-outcome';
import type { EngagementParticipant, EngagementZone } from './engagement-zone';
import type { DynamicSimulationRoster, SimulationLifecycle } from './dynamic-simulation-participant';
import { isControllable, type Controllable } from './dynamic-entity/controllable';

function readyToSpawn(record: SpawnRecord): boolean {
  const gate: SpawnGate | null = findEntityClass(record.entity.kind)?.spawnGate(record.entity) ?? null;
  return gate === null || gate();
}

function isEnemyRecord(record: SpawnRecord): boolean {
  return isSerializedEnemy(record.entity);
}

export class EntityLifecycle implements EntityRegistry, DynamicSimulationRoster, SimulationLifecycle {
  private readonly entities: DynamicEntity[] = [];
  private readonly pendingSpawns: SpawnRecord[] = [];
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

  public spawnWhenReady(record: SpawnRecord): void {
    // 直列化された記録は未検証の値なので、実体の無い待機記録は捨てる(旧い記録に残る
    // 廃止済み種別の要求がここへ来る)。
    if (record.entity === undefined) return;
    if (readyToSpawn(record)) this.materialize(record);
    else this.pendingSpawns.push(record);
  }

  private processPendingSpawns(): void {
    if (this.pendingSpawns.length === 0) return;
    let w = 0;
    for (const record of this.pendingSpawns) {
      if (readyToSpawn(record)) this.materialize(record);
      else this.pendingSpawns[w++] = record;
    }
    this.pendingSpawns.length = w;
  }

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
