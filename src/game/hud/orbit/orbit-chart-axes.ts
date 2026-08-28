// 軌道分析パネルの時間軸・距離軸を、OrbitChart が描ける ChartAxis の形へ組み立てる。
// 目盛り間隔の候補ラダーと、時間 [s] / 距離 [m] それぞれの単位系に応じたラベル書式を持つ。
import { fmtDuration } from '../utils';
import type { ChartAxis, ChartTick } from './orbit-chart';
import { chooseTickInterval, chooseTickIntervalFrom } from './tick-scale';

// 0 秒から spanSec までの時間軸。目盛り間隔は chooseTickInterval が選ぶ。
export function timeAxis(spanSec: number, maxTicks: number, caption: string): ChartAxis {
  const span = isFinite(spanSec) && spanSec > 0 ? spanSec : 0;
  if (span === 0) return { min: 0, max: 0, ticks: [], caption };
  const interval = chooseTickInterval(span, maxTicks);
  const ticks: ChartTick[] = [];
  for (let value = 0; value <= span; value += interval) {
    ticks.push({ value, label: fmtDuration(value, interval) });
  }
  return { min: 0, max: span, ticks, caption };
}

// 距離目盛りの候補ラダー [km]、小さい順。1, 2, 5 × 10^n。
const DISTANCE_TICK_INTERVALS_KM = [
  1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000,
] as const;

// spanKm の目盛り本数が maxTicks を超えない最小の間隔 [km] を選ぶ。どの候補でも超えるなら最大の候補を返す。
function chooseDistanceTickIntervalKm(spanKm: number, maxTicks: number): number {
  return chooseTickIntervalFrom(spanKm, maxTicks, DISTANCE_TICK_INTERVALS_KM);
}

// 軸目盛り専用の距離表記。目盛り値は常に km ラダーの丸い数なので、fmtDist の小数
// 表示だと ".00" だけが残って軸ラベル領域からはみ出す — 整数に丸める。
function fmtAxisDist(m: number): string {
  if (Math.abs(m) >= 1e6) return `${Math.round(m / 1e6)} Mm`;
  if (Math.abs(m) >= 1e3) return `${Math.round(m / 1e3)} km`;
  return `${Math.round(m)} m`;
}

// centerM を中央に置いた幅 spanM の距離軸 [m]。目盛りは km 単位のラダーから選ぶ。
// floorAtZero は下端を 0 未満にせず、その分だけ上端へ span を寄せる(高度は 0 未満が
// 意味を持たないため)。
export function distanceAxis(
  centerM: number, spanM: number, maxTicks: number, caption: string, floorAtZero = false,
): ChartAxis {
  const span = isFinite(spanM) && spanM > 0 ? spanM : 0;
  const center = isFinite(centerM) ? centerM : 0;
  if (span === 0) return { min: center, max: center, ticks: [], caption };
  // center を挟む幅 span の範囲を決め、下端が0未満にはみ出すぶんは上端側へ寄せる。
  let min = center - span / 2;
  let max = center + span / 2;
  if (floorAtZero && min < 0) { max -= min; min = 0; }
  // 間隔をラダーから選び、その倍数の位置へ目盛りを置く。
  const intervalM = chooseDistanceTickIntervalKm(span / 1000, maxTicks) * 1000;
  const firstTick = Math.ceil(min / intervalM) * intervalM;
  const ticks: ChartTick[] = [];
  for (let value = firstTick; value <= max; value += intervalM) {
    ticks.push({ value, label: fmtAxisDist(value) });
  }
  return { min, max, ticks, caption };
}
