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

// 時間軸 [-pastSec, durationSec] を chooseTickInterval が選ぶ間隔の倍数で刻んだ目盛り列を返す。
// t は軸全体に対する位置(0..1)で、ラベルは現在(経過0)からの符号付き経過時間。
// 軸の端ちょうどが間隔の倍数でない場合、その端には目盛りを置かない。
export function buildTicks(durationSec: number, maxTicks: number, pastSec = 0): readonly DisplayTick[] {
  // 非有限値では加算のループが終わらないので、目盛りを置かずに返す。
  if (!isFinite(durationSec) || durationSec <= 0 || !isFinite(pastSec) || pastSec < 0) return [];
  const total = durationSec + pastSec;
  const interval = chooseTickInterval(total, maxTicks);
  const ticks: DisplayTick[] = [];
  for (let elapsed = -Math.floor(pastSec / interval) * interval; elapsed <= durationSec; elapsed += interval) {
    const sign = elapsed < 0 ? '-' : '+';
    ticks.push({ t: (elapsed + pastSec) / total, label: `T${sign}${fmtDuration(Math.abs(elapsed), interval)}` });
  }
  return ticks;
}

// 現在からの符号なしの経過 sec を、上位2単位までの "T+1h 14m" 形式で書く。事象までの残りなど、
// 目盛りより細かい精度で読ませる値に使う。
export function fmtOffsetLabel(sec: number): string {
  if (!isFinite(sec)) return 'T+--';
  const total = Math.round(Math.max(0, sec));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts = days > 0 ? [`${days}d`, `${hours}h`]
    : hours > 0 ? [`${hours}h`, `${minutes}m`]
      : minutes > 0 ? [`${minutes}m`, `${seconds}s`]
        : [`${seconds}s`];
  return `T+${parts.join(' ')}`;
}

// 表示期間 sec を、単位を選んで日本語で書く(例: "6時間"・"10日"・"3ヶ月"・"1年")。
export function fmtSpanLabel(sec: number): string {
  const trim = (value: number): string => String(Math.round(value * 100) / 100);
  if (sec < 86400) return `${trim(sec / 3600)}時間`;
  if (sec < 30 * 86400) return `${trim(sec / 86400)}日`;
  if (sec < 365 * 86400) return `${trim(sec / (30 * 86400))}ヶ月`;
  return `${trim(sec / (365 * 86400))}年`;
}
