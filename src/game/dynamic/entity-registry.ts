// 生んだ個体を顔ぶれへ入れる口。生む側は顔ぶれの持ち主(DynamicSystem)そのものではなく
// この口だけを受け取る。
import type { DynamicEntity } from './dynamic-entity/dynamic-entity';

// 個体を実体化してよいかを答える述語。何を待つかは、待つと決めた側だけが知っていればよい。
export type SpawnGate = () => boolean;

export interface EntityRegistry {
  add(entity: DynamicEntity): void;
  spawnWhenReady(gate: SpawnGate | null, build: () => DynamicEntity, onSpawned?: () => void): void;
}
