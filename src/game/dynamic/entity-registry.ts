// 生成したエンティティを登録コレクションへ追加するインターフェース。即座に追加するものと、条件充足を待って追加するものを扱う。
import type { DynamicEntity } from './dynamic-entity/dynamic-entity';
import type { EntityIdAllocators } from './dynamic-entity/entity-id';
import type { SerializedDynamicEntity } from './dynamic-entity/entity-dictionary';
import type { ProteinEnemyRequest } from './dynamic-entity/protein-enemy';
import type { RunEventSink } from '../run-events';

// 個体を実体化可能かを判定する述語関数。何を待機するかは、待機を決定した側のみが保持する。
export type SpawnGate = () => boolean;

// 実体化を待てる個体の記録。直列化した個体を戻すものと、新しく置くタンパク質の敵の要求がある。
// 待つあいだも直列化できる値だけで表す。
export type SpawnRecord =
  | { readonly kind: 'entity'; readonly entity: SerializedDynamicEntity }
  | { readonly kind: 'protein-enemy'; readonly request: ProteinEnemyRequest };

export interface EntityRegistry {
  // このランの id 採番器。生む側はここから自分の種別の id を取る。
  readonly idAllocators: EntityIdAllocators;
  // このランのイベントログ。発生したイベントを記録するインターフェース。
  readonly events: RunEventSink;
  // 個体を現在のエンティティ一覧へ追加する。枠の上限を超えた分は所有者が古いものから破棄する。
  add(entity: DynamicEntity): void;
  // record の個体を実体化して add する。実体化に要る外部資源がいま揃っていればその場で、そうで
  // なければ揃ったフレームで入れる。
  spawnWhenReady(record: SpawnRecord): void;
  // 外部リソースが揃うのを待機中で、まだエンティティ一覧に追加されていない敵の数。
  readonly pendingEnemyCount: number;
}
