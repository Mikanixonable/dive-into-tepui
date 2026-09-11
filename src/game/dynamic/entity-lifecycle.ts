// DynamicSystem がエンティティの顔ぶれと寿命を委譲するためのゲーム側ポート。生成済み個体の
// 所有や表示資源の具体的な実装はここへ持ち込まず、追加・pending spawn・死亡・除去の順序を
// 名前付きの境界として表す。

import type { DynamicEntity } from './dynamic-entity/dynamic-entity';

// pending spawn が実体化してよいかを決める条件。待つ理由はこの契約の外側に閉じ込める。
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

// 死亡を顔ぶれからの除去へ進める前の境界。死亡判定そのものは DynamicEntity/Motion が持つ。
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
