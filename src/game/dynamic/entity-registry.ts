// 生んだ個体を顔ぶれへ入れる口。即座に入れるものと、条件が揃うのを待ってから入れるものを扱う。
import type { DynamicEntity } from './dynamic-entity/dynamic-entity';

// 個体を実体化してよいかを答える述語。何を待つかは、待つと決めた側だけが知っていればよい。
export type SpawnGate = () => boolean;

export interface EntityRegistry {
  // 個体をいまの顔ぶれへ入れる。枠の上限を超えたぶんは持ち主が古いものから落とす。
  add(entity: DynamicEntity): void;
  // gate が真を返したフレームで build を1度だけ呼び、できた個体を add する。gate が null なら
  // 次のフレームで生む。onSpawned は add の後に1度だけ呼ばれる。
  spawnWhenReady(gate: SpawnGate | null, build: () => DynamicEntity, onSpawned?: () => void): void;
}
