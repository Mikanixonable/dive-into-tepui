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

// 登録済みクラスの生成条件を調べ、待機が必要かを返す。
function readyToSpawn(record: SpawnRecord): boolean {
  const gate: SpawnGate | null = findEntityClass(record.entity.kind)?.spawnGate(record.entity) ?? null;
  return gate === null || gate();
}

// 待機中の敵記録を敵数の集計対象か判定する。
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

  // 初期記録を生成可能な個体と待機記録へ振り分ける。
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

  // 現在の世代に対応する操作可能個体の読み取り専用一覧を返す。
  public get controllables(): readonly Controllable[] {
    this.refreshDerivedCollections();
    return this.controllableCache;
  }

  // 実体化を待つ敵記録の数を返す。
  public get pendingEnemyCount(): number {
    let count = 0;
    for (const record of this.pendingSpawns) {
      if (isEnemyRecord(record)) count++;
    }
    return count;
  }

  // 現在のエンティティ集合を読み取り専用として返す。
  public all(): readonly DynamicEntity[] { return this.entities; }

  // 現在の世代に対応する運動一覧を返す。
  public allMotions(): readonly DynamicMotion[] {
    this.refreshDerivedCollections();
    return this.motionCache;
  }

  // 個体を管理対象へ加え、上限確認と派生一覧の更新を予約する。
  public add(entity: DynamicEntity): void {
    this.entities.push(entity);
    if (entity.capKind !== null) this.capsUncheckedSinceAdd = true;
    this.bumpCollectionRevision();
  }

  // 生成条件が満たされていれば実体化し、そうでなければ待機列へ加える。
  public spawnWhenReady(record: SpawnRecord): void {
    // 直列化された記録は未検証の値なので、実体の無い待機記録は捨てる(旧い記録に残る
    // 廃止済み種別の要求がここへ来る)。
    if (record.entity === undefined) return;
    if (readyToSpawn(record)) this.materialize(record);
    else this.pendingSpawns.push(record);
  }

  // 条件を満たした待機記録を実体化し、残りを順序を保って待機列に残す。
  private processPendingSpawns(): void {
    if (this.pendingSpawns.length === 0) return;
    let w = 0;
    for (const record of this.pendingSpawns) {
      if (readyToSpawn(record)) this.materialize(record);
      else this.pendingSpawns[w++] = record;
    }
    this.pendingSpawns.length = w;
  }

  // 管理対象から外れた個体の資源を解放する。
  public remove(entity: DynamicEntity): void {
    if (!this.detach(entity)) return;
    entity.dispose();
  }

  // 管理中の全個体へ履歴の保持時間を渡す。
  public requestHistoryDuration(sec: number): void {
    for (const entity of this.entities) entity.motion.requestHistoryDuration(sec);
  }

  // 管理中の個体を保存用の記録へ写す。
  public serializedEntities(): readonly SerializedDynamicEntity[] {
    return this.entities.map(entity => entity.serialize());
  }

  // 現在の待機記録を読み取り専用として返す。
  public pendingSpawnRecords(): readonly SpawnRecord[] { return this.pendingSpawns; }

  // 待機生成・寿命判定・上限適用・死亡個体の回収を進める。
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

  // 管理中の個体を解放し、全ての記録を空にする。
  public dispose(): void {
    for (const entity of this.entities) entity.dispose();
    this.entities.length = 0;
    this.pendingSpawns.length = 0;
    this.bumpCollectionRevision();
  }

  // 登録済みクラスがある記録を個体へ復元し、管理対象へ加える。
  private materialize(record: SpawnRecord): void {
    const entityClass = findEntityClass(record.entity.kind);
    if (entityClass !== null) this.add(entityClass.deserialize(record.entity, this, this.scene));
  }

  // 個体が管理対象なら集合から外し、所属の有無を返す。
  private detach(entity: DynamicEntity): boolean {
    const index = this.entities.indexOf(entity);
    if (index < 0) return false;
    this.entities.splice(index, 1);
    this.bumpCollectionRevision();
    return true;
  }

  // 種別ごとの上限を超えた個体を死亡状態にする。
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

  // 寿命を終えた個体を解放し、残る集合の世代を更新する。
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
