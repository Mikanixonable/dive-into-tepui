// 表示時間軸の目盛り間隔を、期間の長さに応じて決める。
import { fmtDuration } from '../../../hud/format';

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

export interface DisplayTick { readonly t: number; readonly label: string }

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

// 時間軸 [−spanSec/2, +spanSec/2](中央が現在)を chooseTickInterval が選ぶ間隔の倍数で刻んだ
// 目盛り列を返す。t は軸全域に対する位置(0.5 が現在)。両端が間隔の倍数でない場合、その端には
// 目盛りを置かない。
export function buildTicks(spanSec: number, maxTicks: number): readonly DisplayTick[] {
  // 非有限値では加算のループが終わらないので、目盛りを置かずに返す。
  if (!isFinite(spanSec) || spanSec <= 0) return [];
  const interval = chooseTickInterval(spanSec, maxTicks);
  const ticks: DisplayTick[] = [];
  const half = spanSec / 2;
  // 軸の両端が間隔の倍数でないとき、その端には目盛りを置かない — 刻むのは軸の内側にある
  // 間隔の倍数だけ。
  const first = Math.ceil(-half / interval);
  const last = Math.floor(half / interval);
  for (let i = first; i <= last; i++) {
    const offset = i * interval;
    ticks.push({
      t: (offset + half) / spanSec,
      label: offset === 0 ? '0' : `T${offset > 0 ? '+' : '−'}${fmtDuration(Math.abs(offset), interval)}`,
    });
  }
  return ticks;
}
