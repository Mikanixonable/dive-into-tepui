// 天気の診断から導く対流セルの大きさ。雲の型(閉じた細胞・開いた細胞・孤立対流・熱帯の集団・
// 前線帯の粒、巻雲では繊維・鱗・金床残滓)ごとのプロトタイプ径を、その型らしい空を指す診断の
// 門で重み付けし、log 域で加重混合する — 重みは連続なので径は場所の間で跳ばない。値は
// log2(径 [km]) のまま雲場へ焼き、描画側が細部の基本スケールとして読む。値はすべて見えの
// ための調整値(cloud-tuning.ts)。
import { float, length, log2, smoothstep } from 'three/tsl';
import { CLOUD_TUNING } from '../cloud-tuning';
import type { WeatherSample } from '../weather-model';
import type { FloatNode, Vec2Node } from '../../tsl-types';

// 積雲の型ごとのプロトタイプ径 [km]。実測の概数(Wood 2012 の中規模細胞対流レビュー等)を
// 取り、すべて調整値から読む。
const CELL_CLOSED_KM = CLOUD_TUNING.cellClosedKm; // 閉じた細胞(層積雲の板)
const CELL_OPEN_KM = CLOUD_TUNING.cellOpenKm; // 開いた細胞(寒気噴出・fetch 長)
const CELL_LAND_KM = CLOUD_TUNING.cellLandKm; // 陸上の孤立対流
const CELL_CLUSTER_KM = CLOUD_TUNING.cellClusterKm; // 熱帯の集団
const CELL_BAND_KM = CLOUD_TUNING.cellBandKm; // 前線帯の粒
const CELL_MARINE_KM = CLOUD_TUNING.cellMarineKm; // 既定(中緯度の海)
// 開いた細胞が立ち始める寒気の流入 [rad] と、そのまま信じる深さ。
const CELL_OPEN_WARMTH_ONSET = CLOUD_TUNING.cellOpenWarmthOnset;
const CELL_OPEN_WARMTH_FULL = CLOUD_TUNING.cellOpenWarmthFull;
// どの門も開かない所へ常時足す小さな重み。ゼロ除算を避け、既定の径へ滑らかに戻す。
const CELL_RESIDUAL_WEIGHT = CLOUD_TUNING.cellResidualWeight;

// 巻雲の要素径(繊維・鱗のピッチ) [km] とその門。
const CIRRUS_CELL_FIBER_KM = CLOUD_TUNING.cirrusCellFiberKm; // 繊維(ジェット下・揃った流れ)
const CIRRUS_CELL_MACKEREL_KM = CLOUD_TUNING.cirrusCellMackerelKm; // 鱗(撹乱上層)
const CIRRUS_CELL_ANVIL_KM = CLOUD_TUNING.cirrusCellAnvilKm; // 金床残滓
const CIRRUS_CELL_SHEET_KM = CLOUD_TUNING.cirrusCellSheetKm; // 既定(無撹乱の板)
const CIRRUS_CELL_RESIDUAL_WEIGHT = CLOUD_TUNING.cirrusCellResidualWeight;
// 繊維が揃い始める上層の風速と、そのまま信じる風速 [m/s]。筋の揃い度の門(4..16 m/s)より
// 強い側で立つ — ジェットの下だけを拾う。
const CIRRUS_FIBER_WIND_ONSET = CLOUD_TUNING.cirrusFiberWindOnset;
const CIRRUS_FIBER_WIND_FULL = CLOUD_TUNING.cirrusFiberWindFull;

// 型ごとの (径 [km], 門の重み) から、log2(km) の加重混合 Σ w·log2(s) / Σ w を返す。
// 定数の残余項を並べておくので、重みの和は 0 にならない。
function weightedLogSize(terms: readonly (readonly [FloatNode, FloatNode])[]): FloatNode {
  let weightSum: FloatNode = float(0);
  let logSum: FloatNode = float(0);
  for (const [sizeKm, weight] of terms) {
    weightSum = weightSum.add(weight);
    logSum = logSum.add(log2(sizeKm).mul(weight));
  }
  return logSum.div(weightSum);
}

// 天気の診断から、積雲と巻雲のセル径 log2(km)。stratocumulus は condense が閉じた細胞の門として
// 組んだ層積雲の強さ、cirrusFlow は同じく condense が組んだ筋の倍角ベクトル(長さが揃い度)。
export function cellSizesOf(
  weather: WeatherSample, stratocumulus: FloatNode, cirrusFlow: Vec2Node,
): { readonly cumulusCell: FloatNode; readonly cirrusCell: FloatNode } {
  // 積雲 — 閉じた細胞は層積雲の門そのまま、開いた細胞は寒気の流入が海を渡った時間(fetch)で
  // 立ち、陸では孤立対流が小さく、年中曇りの湿った低活発度の熱帯では集団が大きく、前線帯は
  // 帯に埋まった粒になる。
  const cumulusCell = weightedLogSize([
    [CELL_CLOSED_KM, stratocumulus],
    [
      CELL_OPEN_KM,
      weather.oceanFetch.mul(
        smoothstep(CELL_OPEN_WARMTH_ONSET, CELL_OPEN_WARMTH_FULL, weather.warmth.negate())),
    ],
    [CELL_LAND_KM, weather.landFraction.mul(weather.convectiveActivity)],
    [
      CELL_CLUSTER_KM,
      weather.meanCloudiness.mul(weather.surfaceHumidity).mul(weather.convectiveActivity.oneMinus()),
    ],
    [CELL_BAND_KM, weather.band],
    [CELL_MARINE_KM, CELL_RESIDUAL_WEIGHT],
  ]);
  // 巻雲 — 繊維は揃った強い流れ(ジェット)、鱗は対流の強い陸(細部のピッチ縮小と同じ向き)、
  // 金床残滓は渦の芯が敷いた天蓋。
  const cirrusCell = weightedLogSize([
    [
      CIRRUS_CELL_FIBER_KM,
      length(cirrusFlow).mul(
        smoothstep(CIRRUS_FIBER_WIND_ONSET, CIRRUS_FIBER_WIND_FULL, length(weather.upperWind))),
    ],
    [CIRRUS_CELL_MACKEREL_KM, weather.convectiveActivity.mul(weather.landFraction)],
    [CIRRUS_CELL_ANVIL_KM, weather.anvil],
    [CIRRUS_CELL_SHEET_KM, CIRRUS_CELL_RESIDUAL_WEIGHT],
  ]);
  return { cumulusCell, cirrusCell };
}
