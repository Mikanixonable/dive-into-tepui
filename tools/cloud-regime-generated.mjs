// 生成側のタイルの標本を、全球の気象状態の読み出し(loadGeneratedWeather)から作る共有部品。
// compare(描画の絵)と audit(物理量)の両方がここを通す — 節点の格子の組み方・タイルの中心で
// 直接引く量・ISCCP 分類の読み方は、同じ処理を 2 か所に書かないためにここに置く。
import {
  NODE_COUNT, conditionsAt, nodeOffsetKm, offsetToLatLon,
} from './cloud-regime-reanalysis.mjs';
import { isccpClassOf, tauBand, topBand } from './cloud-regime-physical.mjs';

// タイルの物差し。実写の教師と同じ 8×8 の格子・一辺 256 km(64 px × 4 km/px)。
export const GRID = 8;
export const TILE_KM = 256;
// ISCCP 分類の標本点。タイルの中に 6×6 を等間隔に置く(1 点あたり面積の重み 1/36)。
// 全球の気象状態は 0.5°(約 55 km)刻みなので、タイル 256 km の中のサンプルとしては十分細かい。
export const PHYS_POINTS_PER_SIDE = 6;
// 巻雲が雲として検出できる柱の光学的厚みの下限。MODIS の雲の検出の下限の目安として τ = 0.3 を
// 使う(実写の雲マスクと同じくらいの感度で、生成の巻雲を雲の有無へ畳むため)。同じ下限で
// 積雲の雲頂も「積雲が見えるときだけ雲頂へ数える」判定に使う。
export const DETECT_TAU = 0.3;
// 積雲の不透明度(点の中の雲の面積の割合として読む)がこれ未満の点は全面を晴天にする。
// 衛星では画素の 2% 未満の雲量は雲と判定されない目安として、面積の端数を晴天へ畳む。
export const CLEAR_OPACITY_MAX = 0.02;

const ISCCP_NAMES = [
  'cirrus', 'cirrostratus', 'deepConvection',
  'altocumulus', 'altostratus', 'nimbostratus',
  'cumulus', 'stratocumulus', 'stratus',
];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// 場面の節点(実写と同じ 7×7)の量を、全球の気象状態から双線形で引く。
// 生成器に対応の無い量(t850・t700・rh700・rh300)は null の列 — conditionsAt が対応する条件を
// null へ落とすので、欠測はここへ置くだけでよい。
export function generatedNodes(weather, lat0, lon0) {
  const nodes = {
    slp: [], w500: [], u850: [], v850: [], u300: [], v300: [],
    t850: Array(NODE_COUNT * NODE_COUNT).fill(null),
    t700: Array(NODE_COUNT * NODE_COUNT).fill(null),
    rh700: Array(NODE_COUNT * NODE_COUNT).fill(null),
    rh300: Array(NODE_COUNT * NODE_COUNT).fill(null),
  };
  for (let j = 0; j < NODE_COUNT; j++) {
    for (let i = 0; i < NODE_COUNT; i++) {
      const { xKm, yKm } = nodeOffsetKm(i, j);
      const { lat, lon } = offsetToLatLon(lat0, lon0, xKm, yKm);
      const s = weather.sampleAt(lat, lon);
      nodes.slp.push(s.pressure);
      nodes.w500.push(s.lift);
      nodes.u850.push(s.surfaceWindEast);
      nodes.v850.push(s.surfaceWindNorth);
      nodes.u300.push(s.upperWindEast);
      nodes.v300.push(s.upperWindNorth);
    }
  }
  return nodes;
}

// 場面の 8×8 タイルそれぞれへ、節点から導く条件とタイルの中心で直接引く量を付けた
// 標本の並びを返す(features は呼び出し側が絵か物理量から付ける)。
// 返す要素: { scene, tile, row, col, xKm, yKm, lat, lon, conditions }。
export function generatedTileConditions(scene, weather) {
  const nodes = generatedNodes(weather, scene.latitude, scene.longitude);
  const out = [];
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      const xKm = (col - (GRID - 1) / 2) * TILE_KM;
      const yKm = ((GRID - 1) / 2 - row) * TILE_KM;
      const { lat, lon } = offsetToLatLon(scene.latitude, scene.longitude, xKm, yKm);
      const s = weather.sampleAt(lat, lon);
      const conditions = {
        ...conditionsAt(nodes, xKm, yKm, { slpReference: 0 }),
        advection: s.warmth,
        front: s.compression,
        humidLow: s.surfaceHumidity,
        humidUp: s.upperHumidity,
        land: s.landFraction,
        meanCloudiness: s.meanCloudiness,
        band: s.band,
        convectiveActivity: s.convectiveActivity,
        anvil: s.anvil,
        lat,
        cao: null,
        pw: null,
      };
      out.push({
        side: 'generated',
        scene: scene.scene,
        tile: `r${row}c${col}`,
        row,
        col,
        xKm,
        yKm,
        lat,
        lon,
        conditions,
      });
    }
  }
  return out;
}

// 標本点の雲の物理量(1 点 = { cumulusTauIn, coverage, cirrusTau, cumulusTopM, cirrusTopM })
// の並びから、実写と同じ形の physical(ISCCP 分類の面積の割合)を畳む。分母はタイルの
// 全面積(生成では欠測が無いので validFrac は 1)。生成では τ も雲頂も必ずあるので、
// unknownHeightFrac・noTopFrac・*NoTauFrac は 0、相の区別が無いので iceFrac は null。
// cumulusTauIn は積雲の雲の中の光学的厚み τ_in(cloud-kind の H^(5/3) の式)、
// coverage は積雲が点を覆う割合(不透明度)。
//
// 点ごとの面積の配り方:
// - 巻雲が検出できる(cirrusTau ≥ DETECT_TAU)とき: 点の全面が雲。τ = cirrusTau +
//   coverage·cumulusTauIn(積雲が点の一部しか覆わないので柱の平均で足す)、
//   雲頂 = max(cirrusTopM, 積雲が見えるなら cumulusTopM)。
// - それ以外: 面積の coverage が雲、残りは晴天。雲の部分の τ = cumulusTauIn + cirrusTau、
//   雲頂 = cumulusTopM。coverage < CLEAR_OPACITY_MAX の点は全面を晴天にする。
export function isccpPhysical(points) {
  const weight = 1 / points.length;
  const counts = Object.fromEntries(ISCCP_NAMES.map((name) => [name, 0]));
  const topCounts = { high: 0, middle: 0, low: 0 };
  const tauCounts = { thin: 0, mid: 0, thick: 0 };
  const taus = [];
  const tops = [];
  const weights = [];
  let cloudArea = 0;
  const addCloud = (area, tau, topKm) => {
    cloudArea += area;
    counts[isccpClassOf(tau, topKm, null)] += area;
    topCounts[topBand(topKm, null)] += area;
    tauCounts[tauBand(tau)] += area;
    taus.push(tau);
    tops.push(topKm);
    weights.push(area);
  };
  for (const p of points) {
    const cover = isNum(p.coverage) ? p.coverage : 0;
    if (isNum(p.cirrusTau) && p.cirrusTau >= DETECT_TAU) {
      const top = isNum(p.cumulusTauIn) && p.cumulusTauIn >= DETECT_TAU
        ? Math.max(p.cirrusTopM, p.cumulusTopM)
        : p.cirrusTopM;
      addCloud(
        weight,
        p.cirrusTau + cover * (isNum(p.cumulusTauIn) ? p.cumulusTauIn : 0),
        top / 1000,
      );
      continue;
    }
    if (!isNum(p.cumulusTauIn) || cover < CLEAR_OPACITY_MAX) continue;
    addCloud(
      cover * weight,
      p.cumulusTauIn + (isNum(p.cirrusTau) ? p.cirrusTau : 0),
      p.cumulusTopM / 1000,
    );
  }
  // 雲の要素へ面積の重みを付けた分位点(雲の部分だけの分布。実写は雲の画素だけの分位点)。
  const weightedQuantile = (values, ws, q) => {
    const order = values.map((v, i) => [v, ws[i]]).sort((a, b) => a[0] - b[0]);
    const total = order.reduce((s, [, w]) => s + w, 0);
    if (total <= 0) return null;
    let acc = 0;
    for (const [v, w] of order) {
      acc += w;
      if (acc / total >= q) return v;
    }
    return order[order.length - 1][0];
  };
  return {
    validFrac: 1,
    cloudFrac: cloudArea,
    clearFrac: 1 - cloudArea,
    unknownHeightFrac: 0,
    ...counts,
    topHighFrac: topCounts.high,
    topMiddleFrac: topCounts.middle,
    topLowFrac: topCounts.low,
    noTopFrac: 0,
    highNoTauFrac: 0,
    middleNoTauFrac: 0,
    lowNoTauFrac: 0,
    tauThinFrac: tauCounts.thin,
    tauMidFrac: tauCounts.mid,
    tauThickFrac: tauCounts.thick,
    tauMedian: weightedQuantile(taus, weights, 0.5),
    tauP90: weightedQuantile(taus, weights, 0.9),
    topKmMedian: weightedQuantile(tops, weights, 0.5),
    topKmP90: weightedQuantile(tops, weights, 0.9),
    iceFrac: null,
    highThinFrac: counts.cirrus,
    deepFrac: counts.deepConvection,
  };
}

// タイル(中心 xKm・yKm、一辺 TILE_KM)の中に 6×6 の標本点を等間隔に置き、各点で気象状態を
// 双線形に引いて ISCCP 分類の physical を畳む。
export function generatedPhysical(weather, lat0, lon0, xKm, yKm) {
  const points = [];
  const step = TILE_KM / PHYS_POINTS_PER_SIDE;
  for (let j = 0; j < PHYS_POINTS_PER_SIDE; j++) {
    for (let i = 0; i < PHYS_POINTS_PER_SIDE; i++) {
      const { lat, lon } = offsetToLatLon(
        lat0, lon0,
        xKm + (i - (PHYS_POINTS_PER_SIDE - 1) / 2) * step,
        yKm + (j - (PHYS_POINTS_PER_SIDE - 1) / 2) * step,
      );
      const s = weather.sampleAt(lat, lon);
      points.push({
        cumulusTauIn: s.cumulusTauIn,
        coverage: s.coverage,
        cirrusTau: s.cirrusTau,
        cumulusTopM: s.cumulusTopM,
        cirrusTopM: s.cirrusTopM,
      });
    }
  }
  return isccpPhysical(points);
}
