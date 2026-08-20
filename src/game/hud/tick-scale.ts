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
    return calendarBoundaries(fromUnix, fromUnix + durationSec, maxTicks, maxTicks).map((b) => ({
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
