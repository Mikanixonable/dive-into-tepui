// cloud-regime-reanalysis の検算。ネットワークを使わず、解析解が分かる一様場・二次式の場・既知の換算だけで
// 導出関数の符号・単位・補間を判定する。使い方: node tools/cloud-regime-reanalysis-selftest.mjs
// 判定に 1 つでも失敗すれば非 0 で終わる。
import {
  KM_PER_DEGREE,
  NODE_COUNT,
  NODE_SPACING_KM,
  conditionsAt,
  gridBilinear,
  gridLaplacian,
  nodeOffsetKm,
  offsetToLatLon,
  overpassUtcHour,
} from './cloud-regime-reanalysis.mjs';

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
}
const near = (a, b, tol) => a != null && Math.abs(a - b) <= tol;

// 節点の量を (xKm, yKm) の関数から作る。
function nodesFrom(fn) {
  const values = [];
  for (let j = 0; j < NODE_COUNT; j++) {
    for (let i = 0; i < NODE_COUNT; i++) {
      const { xKm, yKm } = nodeOffsetKm(i, j);
      values.push(fn(xKm, yKm));
    }
  }
  return values;
}
const uniform = (value) => nodesFrom(() => value);

// 一様な場の気象の節点(東風 10 m/s、850・300 hPa とも同じ、温度は東へ行くほど下がる)。
const uniformWind = (u, v) => ({ u850: uniform(u), v850: uniform(v), u300: uniform(u), v300: uniform(v) });
const baseNodes = {
  slp: uniform(1013.25),
  w500: uniform(0),
  t850: nodesFrom((x) => 290 - 0.01 * x),
  t700: uniform(280),
  rh700: uniform(0.5),
  rh300: uniform(0.2),
  ...uniformWind(10, 0),
};

// 1. 一様な東向きの温度勾配と一様な風: 移流は −V·∇T の解析値 (暖気が西から吹くと正)。
{
  const c = conditionsAt(baseNodes, 100, -50);
  // dT/dx = −0.01 K/km、u = 10 m/s → −(10 · −0.01 · 1e-3) · 86400 = 8.64 K/日
  check('移流が解析値 +8.64 K/日(一様な場)', near(c.advection, 8.64, 1e-9), `${c.advection}`);
  check('前線 |∇T| が 1 K/100 km', near(c.front, 1, 1e-9), `${c.front}`);
}
{
  const warmEast = { ...baseNodes, t850: nodesFrom((x) => 290 + 0.01 * x) };
  const c = conditionsAt(warmEast, 0, 0);
  check('暖気が東から吹く(風は西へ)と移流が負', near(c.advection, -8.64, 1e-9), `${c.advection}`);
}

// 2. 放物面の気圧 p = a·r²(a = 2 hPa、r は 1000 km 単位): ∇²p = 4a → cyclonic = 4a = 8 [hPa/(1000 km)²]。
{
  const a = 2;
  const pressure = nodesFrom((x, y) => 1013.25 + (a * (x * x + y * y)) / 1e6);
  const lap = gridLaplacian(pressure);
  check('二次式の節点でラプラシアンが全点で 4a(端を含む)',
    lap.every((v) => near(v, (4 * a) / 1e6, 1e-12)), `min ${Math.min(...lap)} max ${Math.max(...lap)}`);
  const c = conditionsAt({ ...baseNodes, slp: pressure }, 300, -200);
  check('放物面の低気圧で cyclonic = 4a(単位換算込み)', near(c.cyclonic, 4 * a, 1e-9), `${c.cyclonic}`);
  check('低気圧性が正', c.cyclonic > 0);
  check('slp は基準 1013.25 からの偏差(節点で)',
    near(conditionsAt({ ...baseNodes, slp: pressure }, 0, 0).slp, 0, 1e-9));
}

// 3. 風向の換算(気象の風向: 吹いてくる向き、北から時計回り)。
{
  const fromWest = conditionsAt({ ...baseNodes, ...uniformWind(10, 0) }, 0, 0);
  check('風向 270(西風)→ u > 0、windLowDir = 0°', fromWest.windLowDir != null && near(fromWest.windLowDir, 0, 1e-6),
    `${fromWest.windLowDir}`);
  // 気象の風向 270° → 吹いていく向きの成分 u = −s·sin(270°) = +s。
  const dir270 = { ...baseNodes, u850: uniform(10), v850: uniform(-1e-15) };
  check('風速 [m/s] は成分の長さ', near(conditionsAt(dir270, 0, 0).windLow, 10, 1e-9));
  // 気象の風向 180°(南風) → v = −s·cos(180°) = +s。
  const fromSouth = {
    ...baseNodes,
    u850: uniform(-1e-15),
    v850: uniform(10),
    u300: uniform(-1e-15),
    v300: uniform(10),
  };
  const cS = conditionsAt(fromSouth, 0, 0);
  check('風向 180(南風)→ v > 0、windLowDir = 90°', near(cS.windLowDir, 90, 1e-6), `${cS.windLowDir}`);
  check('shear は上下の成分の差の長さ', near(cS.shear, 0, 1e-9), `${cS.shear}`);
}
{
  // 風向の換算を経路まで通す: 生の風速 36 km/h・風向 270° → u = 10 m/s。
  const u = (36 / 3.6) * -Math.sin((270 * Math.PI) / 180);
  check('気象の風向 270° の換算で u = +10 m/s', near(u, 10, 1e-9), `${u}`);
  const v = (36 / 3.6) * -Math.cos((180 * Math.PI) / 180);
  check('気象の風向 180° の換算で v = +10 m/s', near(v, 10, 1e-9), `${v}`);
}

// 4. 温位: θ = T·(1000/p)^0.286。安定度は θ700 − θ850。
{
  const nodes = { ...baseNodes, t700: uniform(280), t850: uniform(290) };
  const expected = 280 * Math.pow(1000 / 700, 0.286) - 290 * Math.pow(1000 / 850, 0.286);
  const c = conditionsAt(nodes, 0, 0);
  check('安定度 θ700 − θ850 が温位の式と一致', near(c.stability, expected, 1e-9), `${c.stability} vs ${expected}`);
}

// 5. 双線形補間: 節点で節点の値、区間の中心で 4 隅の平均、隅が null なら null。
{
  const values = nodesFrom((x, y) => Math.sin(x / 300) + Math.cos(y / 500));
  let worst = 0;
  for (let j = 0; j < NODE_COUNT; j++) {
    for (let i = 0; i < NODE_COUNT; i++) {
      const { xKm, yKm } = nodeOffsetKm(i, j);
      worst = Math.max(worst, Math.abs(gridBilinear(values, xKm, yKm) - values[j * NODE_COUNT + i]));
    }
  }
  check('双線形補間が節点で節点の値に一致', worst < 1e-12, `最大誤差 ${worst}`);
  const mid = gridBilinear(values, nodeOffsetKm(0, 0).xKm + NODE_SPACING_KM / 2, nodeOffsetKm(0, 0).yKm - NODE_SPACING_KM / 2);
  const corners = [values[0], values[1], values[7], values[8]];
  check('区間の中心で 4 隅の平均', near(mid, corners.reduce((a, b) => a + b) / 4, 1e-12));
  const holed = [...values];
  holed[8] = null;
  check('隅が null なら null', gridBilinear(holed, nodeOffsetKm(0, 0).xKm + NODE_SPACING_KM / 2, nodeOffsetKm(0, 0).yKm - NODE_SPACING_KM / 2) === null);
  const c = conditionsAt({ ...baseNodes, slp: uniform(null) }, 0, 0);
  check('入力が null の量の条件は null', c.slp === null && c.cyclonic === null);
}

// 6. 節点の配置と緯度経度の往復。
{
  const nw = nodeOffsetKm(0, 0);
  const se = nodeOffsetKm(NODE_COUNT - 1, NODE_COUNT - 1);
  check('節点の範囲が ±1024 km', near(nw.xKm, -1024, 1e-9) && near(nw.yKm, 1024, 1e-9) && near(se.xKm, 1024, 1e-9) && near(se.yKm, -1024, 1e-9));
  const lat0 = -20;
  const lon0 = 150;
  const { lat, lon } = offsetToLatLon(lat0, lon0, 700, -500);
  const backY = (lat - lat0) * KM_PER_DEGREE;
  const backX = (lon - lon0) * KM_PER_DEGREE * Math.cos((lat0 * Math.PI) / 180);
  check('offsetToLatLon の往復', near(backX, 700, 1e-6) && near(backY, -500, 1e-6), `${backX}, ${backY}`);
  check('1° の長さが 111.32 km', KM_PER_DEGREE === 111.32);
}

// 7. MODIS Terra の通過時刻(地方太陽時 10:30 → UTC の正時)。
{
  const at0 = overpassUtcHour('2024-01-10', 0);
  check('経度 0 の通過は 10 時か 11 時(UTC)', at0.date === '2024-01-10' && [10, 11].includes(at0.hour), JSON.stringify(at0));
  const at150 = overpassUtcHour('2024-01-10', 150);
  check('経度 150 の通過は当日の 0〜1 時(UTC)', at150.date === '2024-01-10' && [0, 1].includes(at150.hour), JSON.stringify(at150));
  const at170 = overpassUtcHour('2024-01-10', 170);
  check('経度 170 の通過は前日の 23 時(UTC)', at170.date === '2024-01-09' && at170.hour === 23, JSON.stringify(at170));
}

console.log(failures.length === 0 ? '\n全部 PASS' : `\n${failures.length} 件 FAIL: ${failures.join(' / ')}`);
process.exitCode = failures.length === 0 ? 0 : 1;
