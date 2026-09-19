// 生んだ個体を顔ぶれへ入れる口。即座に入れるものと、条件が揃うのを待ってから入れるものを扱う。
import type { DynamicEntity } from './dynamic-entity/dynamic-entity';
import type { EntityIdAllocators } from './dynamic-entity/entity-id';
import type { SerializedDynamicEntity } from './dynamic-entity/entity-dictionary';
import type { ProteinEnemyRequest } from './dynamic-entity/protein-enemy';
import type { RunEventSink } from '../run-events';

// 個体を実体化してよいかを答える述語。何を待つかは、待つと決めた側だけが知っていればよい。
export type SpawnGate = () => boolean;

// 実体化を待てる個体の記録。直列化した個体を戻すものと、新しく置くタンパク質の敵の要求がある。
// 待つあいだも直列化できる値だけで表す。
export type SpawnRecord =
  | { readonly kind: 'entity'; readonly entity: SerializedDynamicEntity }
  | { readonly kind: 'protein-enemy'; readonly request: ProteinEnemyRequest };

export interface EntityRegistry {
  // このランの id 採番器。生む側はここから自分の種別の id を取る。
  readonly idAllocators: EntityIdAllocators;
  // このランの出来事の記録。起きたことを積む側はここへ積む。
  readonly events: RunEventSink;
  // 個体をいまの顔ぶれへ入れる。枠の上限を超えたぶんは持ち主が古いものから落とす。
  add(entity: DynamicEntity): void;
  // record の個体を実体化して add する。実体化に要る外部資源がいま揃っていればその場で、そうで
  // なければ揃ったフレームで入れる。
  spawnWhenReady(record: SpawnRecord): void;
  // 外部資源が揃うのを待っていて、まだ顔ぶれに入っていない敵の数。
  readonly pendingEnemyCount: number;
}
