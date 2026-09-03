// 表示時間軸の目盛り間隔を、期間の長さに応じて決める。
import { fmtDuration } from '../../../hud/utils';

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

// span の目盛り本数(0番目を含む)が maxTicks を超えない最小の間隔を candidates(小さい順)
// から選ぶ。どの候補でも超えるなら最大の候補を返す。
export function chooseTickIntervalFrom(span: number, maxTicks: number, candidates: readonly number[]): number {
  let interval = candidates[0] ?? 0;
  if (!isFinite(span) || span <= 0) return interval;
  for (const candidate of candidates) {
    interval = candidate;
    if (Math.floor(span / candidate) + 1 <= maxTicks) break;
  }
  return interval;
}

// 時間軸の目盛り間隔 [秒] を選ぶ。候補ラダーは TICK_INTERVALS_SEC 固定。
export function chooseTickInterval(durationSec: number, maxTicks: number): number {
  return chooseTickIntervalFrom(durationSec, maxTicks, TICK_INTERVALS_SEC);
}

// [0, durationSec] を chooseTickInterval が選ぶ間隔の倍数で刻んだ目盛り列を返す。
// durationSec ちょうどが間隔の倍数でない場合、その端には目盛りを置かない。
export function buildTicks(durationSec: number, maxTicks: number): readonly DisplayTick[] {
  // 非有限値では加算のループが終わらないので、目盛りを置かずに返す。
  if (!isFinite(durationSec) || durationSec <= 0) return [];
  const interval = chooseTickInterval(durationSec, maxTicks);
  const ticks: DisplayTick[] = [];
  for (let elapsed = 0; elapsed <= durationSec; elapsed += interval) {
    ticks.push({ t: elapsed / durationSec, label: `T+${fmtDuration(elapsed, interval)}` });
  }
  return ticks;
}
