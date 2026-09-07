// いまの顔ぶれを読む口。誰が生み、誰が畳むかを知らずに、その回の全個体を走査する側が使う。
import type { DynamicEntity } from './dynamic-entity/dynamic-entity';

export interface EntityRoster {
  // 保持する全エンティティを追加順に返す。呼び出し側は読み取り専用として扱う。
  all(): readonly DynamicEntity[];
  // 顔ぶれの世代。追加・除去・prune のいずれでも増える。同じ世代なら顔ぶれは変わっていない。
  readonly collectionRevision: number;
  // 顔ぶれをどこまで進めたか(積分の先端時刻)。all() の各個体の状態はこの時刻を指す。
  readonly simTime: number;
}
