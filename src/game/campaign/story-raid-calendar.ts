// 軌道暦と襲撃の予定。襲撃はタイマーではなく、対象拠点の公転周期の整数倍の間隔で
// 並ぶ軌道の出来事として発生する(GAME.md 11.5)。このモジュールは予定の組み立てと
// 局面の判定だけを持ち、編隊の配置と襲撃の帰結はステージが持つ。

// 予報が出る、接近までの残り時間 [sim s]。接近の24時間前から予報として表示される。
export const RAID_FORECAST_LEAD_SECONDS = 24 * 3600;
// 襲撃編隊が姿を現してから、対象拠点へ接近するまでの時間 [sim s]。
export const RAID_APPROACH_SECONDS = 1800;
// 襲撃どうしの間隔。対象拠点の公転周期の何倍かで並ぶ。
export const RAID_INTERVAL_ORBITS = 26;
// 襲撃編隊が接近の後に留まる時間 [sim s]。過ぎれば編隊は離脱する。
export const RAID_LINGER_SECONDS = 1800;

// 襲撃1件の予定。index は幕の中での通し番号(0始まり)。
export interface RaidPlanEntry {
  readonly index: number;
  // 対象拠点の id。
  readonly targetBaseId: string;
  // 予報が出る時刻 [sim s]。
  readonly forecastAt: number;
  // 編隊が姿を現す時刻 [sim s]。
  readonly spawnAt: number;
  // 対象拠点へ接近する時刻 [sim s]。
  readonly arrivalAt: number;
  // 編隊が離脱する時刻 [sim s]。
  readonly departAt: number;
}

// 幕の開始時刻 startAt [sim s]、対象拠点の公転周期 periodSeconds [sim s]、対象拠点
// targetBaseId から、襲撃 index の予定を組む。第1回は開始から間隔1つ分先に来る。
export function raidPlanEntry(
  index: number, startAt: number, periodSeconds: number, targetBaseId: string,
): RaidPlanEntry {
  const arrivalAt = startAt + periodSeconds * RAID_INTERVAL_ORBITS * (index + 1);
  return {
    index,
    targetBaseId,
    forecastAt: arrivalAt - RAID_FORECAST_LEAD_SECONDS,
    spawnAt: arrivalAt - RAID_APPROACH_SECONDS,
    arrivalAt,
    departAt: arrivalAt + RAID_LINGER_SECONDS,
  };
}

// 時刻 simTime における襲撃の局面。予報が出る前、予報が出て編隊が現れる前、編隊が
// 接近中、編隊が留まっている間、離脱した後の順に移る。
export type RaidPhase = 'before-forecast' | 'forecast' | 'approach' | 'present' | 'departed';

// 襲撃 entry の、時刻 simTime における局面。
export function raidPhaseAt(entry: RaidPlanEntry, simTime: number): RaidPhase {
  if (simTime < entry.forecastAt) return 'before-forecast';
  if (simTime < entry.spawnAt) return 'forecast';
  if (simTime < entry.arrivalAt) return 'approach';
  if (simTime < entry.departAt) return 'present';
  return 'departed';
}

// 襲撃 entry の節目(予報・出現・離脱)のうち、時刻 simTime より後で最も早いもの。
// 無ければ null。ステージがシミュレーションの刻みを節目へ合わせるために使う。
export function nextRaidMilestoneAt(entry: RaidPlanEntry, simTime: number): number | null {
  let next: number | null = null;
  for (const milestone of [entry.forecastAt, entry.spawnAt, entry.departAt]) {
    if (milestone > simTime && (next === null || milestone < next)) next = milestone;
  }
  return next;
}
