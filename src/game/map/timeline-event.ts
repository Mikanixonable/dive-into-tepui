// 時間軸へ目盛りとして載せる、軌道上の事象。種別は ORBIT_POINT_GLYPH の鍵と同じで、字形はそこから引く。

export type TimelineEventKind = 'apsis' | 'ascendingNode' | 'descendingNode' | 'closestApproach' | 'maneuverNode';

export interface TimelineEvent {
  readonly kind: TimelineEventKind;
  // 通過する時刻 [s]。simTime。
  readonly time: number;
  readonly name: string;
}
