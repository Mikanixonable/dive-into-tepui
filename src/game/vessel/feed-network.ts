// 推進剤の流路の敷設(§10)。設計が保存するのは手動で敷いた区間だけであり、自動敷設で導出できる
// 区間は保存せず、設計から毎回導出する — だから FeedRoute は manual: true しか取らない。

import type { PropellantId } from '../economy/propellant-compatibility';

// 手動で敷いた1区間。edgeIds は流路が通るエッジを、タンク側からエンジン側へ順に並べたもの。
export interface FeedRoute {
  readonly id: string;
  readonly propellant: PropellantId;
  readonly edgeIds: readonly string[];
  // 手動の上書きであること。自動敷設の結果はここに現れない。
  readonly manual: true;
}

export interface FeedNetwork {
  readonly routes: readonly FeedRoute[];
}

export const EMPTY_FEED_NETWORK: FeedNetwork = { routes: [] };
