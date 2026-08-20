// 表示時間軸の目盛りを、tickLabelMode に応じて相対/絶対のどちらかで組み立てる。
import { fmtDuration } from './utils';
import { calendarBoundaries, tickLabel, type TickLabelMode } from './calendar-ticks';

// 目盛り間隔の候補ラダー [秒]、小さい順。
const TICK_INTERVALS_SEC = [
  600,
  1800,
  3600,
  3 * 3600,
  6 * 3600,
  12 * 3600,
  86400,
  2 * 86400,
  5 * 86400,
  10 * 86400,
  30 * 86400,
  90 * 86400,
  365 * 86400,
] as const;

export type DisplayTick = { readonly t: number; readonly label: string };

// calendarBoundaries へ渡す候補数の上限。表示本数の上限(maxTicks)とは別物 — calendarBoundaries
// 自身がその上限を超えないランクへ選び直す(hourFamilyMaxCount)ので、maxTicks をそのまま渡すと
// 日単位の候補ですら足りずに月単位へ格上げされ、7日/28日程度の期間で目盛りがほとんど出ない。
// ここは間引き前の候補集めの上限なので、日単位が数ヶ月分は残る大きさを取る。
const CALENDAR_CANDIDATE_MAX_COUNT = 400;
const CALENDAR_CANDIDATE_HOUR_FAMILY_MAX_COUNT = 1200;

// items を先頭・末尾を含めて maxCount 個まで均等な間隔で間引く。
function thinEvenly<T>(items: readonly T[], maxCount: number): readonly T[] {
  if (items.length <= maxCount || maxCount <= 1) return items;
  const step = (items.length - 1) / (maxCount - 1);
  const result: T[] = [];
  for (let i = 0; i < maxCount; i++) {
    const item = items[Math.round(i * step)];
    if (item !== undefined) result.push(item);
  }
  return result;
}

// durationSec の目盛り本数(0番目を含む)が maxTicks を超えない最小の間隔を選ぶ。
// どの候補でも超えるなら最大の候補を返す。
export function chooseTickInterval(durationSec: number, maxTicks: number): number {
  let interval: number = TICK_INTERVALS_SEC[0];
  if (!isFinite(durationSec) || durationSec <= 0) return interval;
  for (const candidate of TICK_INTERVALS_SEC) {
    interval = candidate;
    if (Math.floor(durationSec / candidate) + 1 <= maxTicks) break;
  }
  return interval;
}

// [0, durationSec] の目盛り列を返す。'relative' は chooseTickInterval が選ぶ間隔の倍数で
// T+ 表記、'absolute' は calendarBoundaries が返す暦境界で UTC 表記になる。
export function buildTicks(
  fromUnix: number,
  durationSec: number,
  maxTicks: number,
  mode: TickLabelMode,
): readonly DisplayTick[] {
  // 非有限値では加算のループが終わらないので、目盛りを置かずに返す。
  if (!isFinite(durationSec) || durationSec <= 0) return [];
  if (mode === 'absolute') {
    const boundaries = calendarBoundaries(
      fromUnix, fromUnix + durationSec, CALENDAR_CANDIDATE_MAX_COUNT, CALENDAR_CANDIDATE_HOUR_FAMILY_MAX_COUNT,
    );
    return thinEvenly(boundaries, maxTicks).map((b) => ({
      t: (b.unix - fromUnix) / durationSec,
      label: tickLabel(b.unix, b.rank, 'absolute', fromUnix),
    }));
  }
  const interval = chooseTickInterval(durationSec, maxTicks);
  const ticks: DisplayTick[] = [];
  for (let elapsed = 0; elapsed <= durationSec; elapsed += interval) {
    ticks.push({ t: elapsed / durationSec, label: `T+${fmtDuration(elapsed, interval)}` });
  }
  return ticks;
}
