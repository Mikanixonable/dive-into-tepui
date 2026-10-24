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

// 時間軸のトラック全幅のうち、過去の静的な帯が占める割合の上限と下限。過去は履歴線であり指して
// 動かす対象ではないので、未来側(スライダーの値域)を食わないよう上限で頭打ちにする。過去側の
// 期間が未来側の何倍であっても、未来側は少なくとも 1 - 上限 の幅を保ち、ドラッグで目当ての時刻を
// 指せる。下限は、過去が短くても帯とラベルが読める幅を残す。
export const PAST_REGION_MAX_FRACTION = 0.2;
export const PAST_REGION_MIN_FRACTION = 0.05;

// 過去側の目盛りに許す本数(0番目を含む)。帯が狭いので、ラベルが重ならない本数に絞る。
const PAST_MAX_TICKS = 2;

// トラック全幅のうち、過去の帯が占める割合(0..1)。過去がなければ 0 で、帯を出さない。
// 過去と未来の期間の比に従い、[PAST_REGION_MIN_FRACTION, PAST_REGION_MAX_FRACTION] へ収める。
export function pastRegionFraction(pastSec: number, durationSec: number): number {
  if (!isFinite(pastSec) || !isFinite(durationSec) || pastSec <= 0 || durationSec <= 0) return 0;
  const proportional = pastSec / (pastSec + durationSec);
  return Math.min(PAST_REGION_MAX_FRACTION, Math.max(PAST_REGION_MIN_FRACTION, proportional));
}

// 時間軸 [-pastSec, durationSec] の目盛り列を返す。t はトラック全幅に対する位置(0..1)で、
// 左の pastRegionFraction ぶんが過去の帯、残りが未来側。ラベルは現在(経過0)からの符号付き経過時間。
// 未来側は chooseTickInterval が選ぶ間隔の倍数で刻み、過去側は帯の幅に合わせて別の間隔で刻む。
// 過去の目盛りも本数に数えるので、全体で maxTicks を超えない。軸の端ちょうどが間隔の倍数でない
// 場合、その端には目盛りを置かない。
export function buildTicks(durationSec: number, maxTicks: number, pastSec = 0): readonly DisplayTick[] {
  // 非有限値では加算のループが終わらないので、目盛りを置かずに返す。
  if (!isFinite(durationSec) || durationSec <= 0 || !isFinite(pastSec) || pastSec < 0) return [];
  const pastFraction = pastRegionFraction(pastSec, durationSec);
  const ticks: DisplayTick[] = [];
  if (pastFraction > 0) {
    const pastInterval = chooseTickInterval(pastSec, PAST_MAX_TICKS);
    for (let k = Math.floor(pastSec / pastInterval); k >= 1; k--) {
      const elapsed = k * pastInterval;
      ticks.push({ t: pastFraction * (1 - elapsed / pastSec), label: `T-${fmtDuration(elapsed, pastInterval)}` });
    }
  }
  const interval = chooseTickInterval(durationSec, Math.max(1, maxTicks - ticks.length));
  for (let elapsed = 0; elapsed <= durationSec; elapsed += interval) {
    ticks.push({
      t: pastFraction + (1 - pastFraction) * (elapsed / durationSec),
      label: `T+${fmtDuration(elapsed, interval)}`,
    });
  }
  return ticks;
}

// 現在からの経過 sec(負は過去)を、上位2単位までの "T+1h 14m" 形式で書く。事象までの残りなど、
// 目盛りより細かい精度で読ませる値に使う。符号は保つ("T-2h 5m")。
export function fmtOffsetLabel(sec: number): string {
  if (!isFinite(sec)) return 'T+--';
  const total = Math.round(Math.abs(sec));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts = days > 0 ? [`${days}d`, `${hours}h`]
    : hours > 0 ? [`${hours}h`, `${minutes}m`]
      : minutes > 0 ? [`${minutes}m`, `${seconds}s`]
        : [`${seconds}s`];
  return `T${sec < 0 && total > 0 ? '-' : '+'}${parts.join(' ')}`;
}

// 表示期間 sec を、単位を選んで日本語で書く(例: "6時間"・"10日"・"3ヶ月"・"1年")。
export function fmtSpanLabel(sec: number): string {
  const trim = (value: number): string => String(Math.round(value * 100) / 100);
  if (sec < 86400) return `${trim(sec / 3600)}時間`;
  if (sec < 30 * 86400) return `${trim(sec / 86400)}日`;
  if (sec < 365 * 86400) return `${trim(sec / (30 * 86400))}ヶ月`;
  return `${trim(sec / (365 * 86400))}年`;
}
