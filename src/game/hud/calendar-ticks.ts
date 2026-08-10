// 計画軌道のルーラー目盛りを、暦(時・日・月・年)の区切りに合わせて生成する。

// 目盛階数。数が大きいほど粗い単位 — 0:1時間 1:3時間 2:6時間 3:12時間 4:1日 5:1月 6:1年。
export type TickRank = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface CalendarTick {
  readonly unix: number;
  readonly rank: TickRank;
}

// 階数ごとの目盛り間隔の目安 [秒]。本数の見積りにのみ使う(月・年は平均長)。
const NOMINAL_SEC: Record<TickRank, number> = {
  0: 3600,
  1: 3 * 3600,
  2: 6 * 3600,
  3: 12 * 3600,
  4: 86400,
  5: 2629746, // 365.2425日/12ヶ月
  6: 31556952, // 365.2425日
};

// 時間系階数(0〜3)の間隔 [秒]。いずれも1日を割り切るので UTC 日境界からの倍数で列挙できる。
const HOUR_FAMILY_STEP_SEC: Record<0 | 1 | 2 | 3, number> = {
  0: 3600,
  1: 3 * 3600,
  2: 6 * 3600,
  3: 12 * 3600,
};

// ある瞬間(UNIX秒)が満たす最も粗い階数を返す。calendarBoundaries が生成した境界にのみ使う前提で、
// 分・秒が0でない瞬間は渡さない。
function highestRank(unix: number): TickRank {
  // 粗い階数から順に判定し、最初に満たしたものを採用する。
  const d = new Date(unix * 1000);
  const h = d.getUTCHours();
  const day = d.getUTCDate();
  const month = d.getUTCMonth();
  if (day === 1 && month === 0 && h === 0) return 6;
  if (day === 1 && h === 0) return 5;
  if (h === 0) return 4;
  if (h % 12 === 0) return 3;
  if (h % 6 === 0) return 2;
  if (h % 3 === 0) return 1;
  return 0;
}

// [fromUnix, toUnix] 内の境界本数が maxCount 以下になる最も細かい階数を選ぶ。
// どの階数でも超えるなら最も粗い階数(年)を返す。
function chooseRank(spanSec: number, maxCount: number): TickRank {
  for (let r = 0; r <= 6; r++) {
    const rank = r as TickRank;
    const estCount = spanSec / NOMINAL_SEC[rank] + 1;
    if (estCount <= maxCount) return rank;
  }
  return 6;
}

// 時間系階数(0〜3)の境界を UTC 日始まりからの倍数で列挙する。
function hourFamilyBoundaries(fromUnix: number, toUnix: number, stepSec: number): number[] {
  const dayStart = Math.floor(fromUnix / 86400) * 86400;
  let t = dayStart + Math.ceil((fromUnix - dayStart) / stepSec) * stepSec;
  const result: number[] = [];
  while (t <= toUnix) {
    result.push(t);
    t += stepSec;
  }
  return result;
}

// 日境界(UTC 00:00)を列挙する。UTC には夏時間がないため単純に86400秒刻みでよい。
function dayBoundaries(fromUnix: number, toUnix: number): number[] {
  let t = Math.floor(fromUnix / 86400) * 86400;
  if (t < fromUnix) t += 86400;
  const result: number[] = [];
  while (t <= toUnix) {
    result.push(t);
    t += 86400;
  }
  return result;
}

// 月初(UTC 1日 00:00)を列挙する。月の長さが一定でないため Date.UTC の月インデックス
// 繰り上げに委ねる — 秒数を積算する実装は月境界からずれる。
function monthBoundaries(fromUnix: number, toUnix: number): number[] {
  // m を1ずつ増やすたび Date.UTC が年の繰り上げを解決する。
  const start = new Date(fromUnix * 1000);
  const y = start.getUTCFullYear();
  let m = start.getUTCMonth();
  let t = Date.UTC(y, m, 1) / 1000;
  if (t < fromUnix) {
    m += 1;
    t = Date.UTC(y, m, 1) / 1000;
  }
  const result: number[] = [];
  while (t <= toUnix) {
    result.push(t);
    m += 1;
    t = Date.UTC(y, m, 1) / 1000;
  }
  return result;
}

// 年初(UTC 1/1 00:00)を列挙する。この文書の想定年代は5桁に達するため Date.UTC(y, 0, 1) の
// year 引数をそのまま増減させる(Date.parse/toISOString は5桁年を扱えない)。
function yearBoundaries(fromUnix: number, toUnix: number): number[] {
  // y を1ずつ増やして Date.UTC(y, 0, 1) を求め直す。
  const start = new Date(fromUnix * 1000);
  let y = start.getUTCFullYear();
  let t = Date.UTC(y, 0, 1) / 1000;
  if (t < fromUnix) {
    y += 1;
    t = Date.UTC(y, 0, 1) / 1000;
  }
  const result: number[] = [];
  while (t <= toUnix) {
    result.push(t);
    y += 1;
    t = Date.UTC(y, 0, 1) / 1000;
  }
  return result;
}

// [fromUnix, toUnix] を、本数が maxCount を超えない最も細かい暦階数の境界で刻んだ目盛り列を返す。
// 各目盛りの rank はその瞬間が実際に満たす最も粗い階数(例: 月初 0時は5、それ以外の0時は4)。
export function calendarBoundaries(
  fromUnix: number,
  toUnix: number,
  maxCount: number,
): readonly CalendarTick[] {
  if (!isFinite(fromUnix) || !isFinite(toUnix) || toUnix < fromUnix) return [];
  const rank = chooseRank(toUnix - fromUnix, maxCount);
  // 選ばれた階数に応じた列挙関数へ振り分ける。
  let unixList: number[];
  switch (rank) {
    case 0:
    case 1:
    case 2:
    case 3:
      unixList = hourFamilyBoundaries(fromUnix, toUnix, HOUR_FAMILY_STEP_SEC[rank]);
      break;
    case 4:
      unixList = dayBoundaries(fromUnix, toUnix);
      break;
    case 5:
      unixList = monthBoundaries(fromUnix, toUnix);
      break;
    case 6:
      unixList = yearBoundaries(fromUnix, toUnix);
      break;
  }
  return unixList.map((unix) => ({ unix, rank: highestRank(unix) }));
}

// 目盛りの表示ラベルを rank に応じた書式で返す(時間系は HH:00、日は M/D、月は M月、年は年)。
export function tickLabel(unix: number, rank: TickRank): string {
  const d = new Date(unix * 1000);
  if (rank <= 3) return `${String(d.getUTCHours()).padStart(2, '0')}:00`;
  if (rank === 4) return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  if (rank === 5) return `${d.getUTCMonth() + 1}月`;
  return `${d.getUTCFullYear()}`;
}
