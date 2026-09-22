// 現在のエンティティ一覧を参照するインターフェース。生成や破棄の管理に関わらず、全個体を走査する側が使用する。
import type { DynamicEntity } from './dynamic-entity/dynamic-entity';

export interface EntityRoster {
  // 保持する全エンティティを追加順に返す（読み取り専用）。
  all(): readonly DynamicEntity[];
  // エンティティ集合の世代（リビジョン）。追加・除去・prune のいずれでも増える。同じ世代なら構成は変わっていない。
  readonly collectionRevision: number;
  // シミュレーション先端時刻。all() の各個体の状態はこの時刻を指す。
  readonly simTime: number;
}
