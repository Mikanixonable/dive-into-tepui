// 場面ごとの 7×7 節点の気象量(Open-Meteo Historical Forecast)を取得・キャッシュし、節点の量から
// タイル中心の気象条件を導く部品。生成側も同じ導出関数を使うため、節点の格子と差分・補間はここに置く。
// 取得は予報モデルの解析値・短時間予報で、再解析そのものではない。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const CACHE_DIR = path.join(root, '.cloud-detail', 'regime', 'reanalysis-cache');
const API_URL = 'https://historical-forecast-api.open-meteo.com/v1/forecast';
const USER_AGENT = 'cloud-regime-teacher';
// 1 リクエストの間隔 [ms]。無料枠は 1 分 600 地点。49 節点の 1 リクエストを 6.5 秒おきにすると 1 分 452 地点で、枠の内側に収まる。
const REQUEST_INTERVAL_MS = 6500;
// 1 リクエストの変数は 10 個までに収める(超えると枠を倍に数えられる)。
const VARIABLES = [
  'pressure_msl',
  'vertical_velocity_500hPa',
  'temperature_850hPa',
  'temperature_700hPa',
  'relative_humidity_700hPa',
  'relative_humidity_300hPa',
  'wind_speed_850hPa',
  'wind_direction_850hPa',
  'wind_speed_300hPa',
  'wind_direction_300hPa',
];

export const NODE_COUNT = 7;
// 節点の間隔 [km]。端から端まで ±1024 km。
export const NODE_SPACING_KM = 1024 / 3;
// 緯度 1° の長さ [km]。cloud-detail-random-teacher.mjs と cloud-translucent-gibs.mjs の KM_PER_DEGREE と同じ値。
export const KM_PER_DEGREE = 111.32;
const CENTER = (NODE_COUNT - 1) / 2;
// 乾燥断熱の指数 R/cp。
const KAPPA = 0.286;
// 500 hPa の鉛直速度の符号。Open-Meteo の値を検算した結果を入れる(上昇が正なら +1、逆なら −1)。
const W500_SIGN = 1;
// Terra の地方太陽時の通過時刻 10:30。cloud-translucent-gibs.mjs の overpassUtcMillis と同じ式。
const TERRA_LOCAL_HOUR = 10.5;

// 節点 (i 列 西→東, j 行 北→南) の場面中心からの (xKm 東向き, yKm 北向き)。
export function nodeOffsetKm(i, j) {
  return { xKm: (i - CENTER) * NODE_SPACING_KM, yKm: (CENTER - j) * NODE_SPACING_KM };
}

// 場面中心 (lat0, lon0) の接平面で (xKm, yKm) の点の緯度経度 [度]。経度の換算は中心の緯度の cos を使う。
export function offsetToLatLon(lat0, lon0, xKm, yKm) {
  return {
    lat: lat0 + yKm / KM_PER_DEGREE,
    lon: lon0 + xKm / (KM_PER_DEGREE * Math.cos((lat0 * Math.PI) / 180)),
  };
}

// 日付と経度の場面で MODIS Terra が通過する UTC の正時。日付をまたぐことがある。
export function overpassUtcHour(dateString, lonDeg) {
  const epoch = Date.parse(`${dateString}T00:00:00Z`);
  const millis = epoch + (TERRA_LOCAL_HOUR - lonDeg / 15) * 3600e3;
  const hourMillis = Math.round(millis / 3600e3) * 3600e3;
  const date = new Date(hourMillis);
  return { date: date.toISOString().slice(0, 10), hour: date.getUTCHours() };
}

// 場面の節点の量がキャッシュ済みか。
export function isSceneCached(sceneId) {
  return existsSync(path.join(CACHE_DIR, `${sceneId}.json`));
}

// 枠切れ(HTTP 429 か、枠切れを示す応答)。
export class QuotaExceeded extends Error {}

let lastRequestAt = 0;

async function waitForInterval() {
  const wait = lastRequestAt + REQUEST_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

// IPv6 の経路が使えない環境があるので、IPv4 に限定して取る。
function requestText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { family: 4, headers: { 'User-Agent': USER_AGENT }, timeout: 60000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const pad2 = (n) => String(n).padStart(2, '0');
const toKelvin = (celsius) => celsius + 273.15;

// 風速 [km/h] と気象の風向(吹いてくる向き、北から時計回り [度])から、吹いていく向きの東向き・北向きの成分 [m/s]。
function windComponents(speedKmh, dirDeg) {
  if (speedKmh == null || dirDeg == null) return { u: null, v: null };
  const speed = speedKmh / 3.6;
  const rad = (dirDeg * Math.PI) / 180;
  return { u: -speed * Math.sin(rad), v: -speed * Math.cos(rad) };
}

// 1 リクエストで 49 節点を取り、節点の量(行優先 j·7 + i)へ単位を揃えて並べる。
async function fetchNodeValues(scene, utc) {
  const lats = [];
  const lons = [];
  for (let j = 0; j < NODE_COUNT; j++) {
    for (let i = 0; i < NODE_COUNT; i++) {
      const { xKm, yKm } = nodeOffsetKm(i, j);
      const { lat, lon } = offsetToLatLon(scene.latitude, scene.longitude, xKm, yKm);
      lats.push(lat.toFixed(4));
      lons.push(lon.toFixed(4));
    }
  }
  const url =
    `${API_URL}?latitude=${lats.join(',')}&longitude=${lons.join(',')}` +
    `&start_date=${utc.date}&end_date=${utc.date}&timezone=GMT&hourly=${VARIABLES.join(',')}`;

  await waitForInterval();
  const { status, body } = await requestText(url);
  if (status === 429 || (status !== 200 && /limit/i.test(body))) {
    throw new QuotaExceeded(`HTTP ${status}: ${body.slice(0, 200)}`);
  }
  if (status !== 200) throw new Error(`HTTP ${status}: ${body.slice(0, 200)}`);
  const points = JSON.parse(body);
  if (!Array.isArray(points) || points.length !== NODE_COUNT * NODE_COUNT) {
    throw new Error(`節点の数が合わない: ${Array.isArray(points) ? points.length : 'not an array'}`);
  }

  const idx = points[0].hourly.time.indexOf(`${utc.date}T${pad2(utc.hour)}:00`);
  if (idx < 0) throw new Error(`時刻が応答に無い: ${utc.date}T${pad2(utc.hour)}:00`);
  const pick = (p, name, convert = (v) => v) => {
    const v = p.hourly[name]?.[idx];
    return v == null ? null : convert(v);
  };
  const wind = (p, level) => windComponents(pick(p, `wind_speed_${level}hPa`), pick(p, `wind_direction_${level}hPa`));
  return {
    slp: points.map((p) => pick(p, 'pressure_msl')),
    w500: points.map((p) => pick(p, 'vertical_velocity_500hPa')),
    t850: points.map((p) => pick(p, 'temperature_850hPa', toKelvin)),
    t700: points.map((p) => pick(p, 'temperature_700hPa', toKelvin)),
    rh700: points.map((p) => pick(p, 'relative_humidity_700hPa', (v) => v / 100)),
    rh300: points.map((p) => pick(p, 'relative_humidity_300hPa', (v) => v / 100)),
    u850: points.map((p) => wind(p, 850).u),
    v850: points.map((p) => wind(p, 850).v),
    u300: points.map((p) => wind(p, 300).u),
    v300: points.map((p) => wind(p, 300).v),
  };
}

// 場面の節点の量を返す。キャッシュ(.cloud-detail/regime/reanalysis-cache/<scene>.json)があれば読むだけで、
// 無ければ取得して保存する。キャッシュは符号の補正の前の値を持つ。
// scene = { scene, latitude, longitude, date }。戻り値 { scene, utc, nodes }(nodes の単位は hPa・m/s・K・0..1・m/s)。
export async function fetchSceneNodes(scene) {
  const utc = overpassUtcHour(scene.date, scene.longitude);
  const cachePath = path.join(CACHE_DIR, `${scene.scene}.json`);
  let cached;
  if (existsSync(cachePath)) {
    cached = JSON.parse(readFileSync(cachePath, 'utf8'));
  } else {
    cached = { scene: scene.scene, utc, nodes: await fetchNodeValues(scene, utc) };
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cached));
  }
  const { w500 } = cached.nodes;
  return {
    scene: cached.scene,
    utc: cached.utc,
    nodes: { ...cached.nodes, w500: w500.map((v) => (v == null ? null : v * W500_SIGN)) },
  };
}

// 7 点の列(増える座標の順)の一階微分。内部は中心差分、端は片側差分。
function lineFirstDerivative(line, spacing) {
  const last = line.length - 1;
  return line.map((_, k) => {
    if (k === 0) return line[1] == null || line[0] == null ? null : (line[1] - line[0]) / spacing;
    if (k === last) return line[last] == null || line[last - 1] == null ? null : (line[last] - line[last - 1]) / spacing;
    const a = line[k - 1];
    const b = line[k + 1];
    return a == null || b == null ? null : (b - a) / (2 * spacing);
  });
}

// 7 点の列の二階微分。内部は中心差分、端は 4 点の片側式(二次式を厳密に返す)。
function lineSecondDerivative(line, spacing) {
  const last = line.length - 1;
  const s2 = spacing * spacing;
  return line.map((_, k) => {
    let points;
    if (k === 0) points = [line[0], line[1], line[2], line[3]];
    else if (k === last) points = [line[last], line[last - 1], line[last - 2], line[last - 3]];
    else {
      const a = line[k - 1];
      const b = line[k + 1];
      return a == null || b == null || line[k] == null ? null : (a - 2 * line[k] + b) / s2;
    }
    if (points.some((v) => v == null)) return null;
    const [f0, f1, f2, f3] = points;
    return (2 * f0 - 5 * f1 + 4 * f2 - f3) / s2;
  });
}

// 節点の行(西→東)と列(南→北)を取り出す。戻り値は行 j の 7 点、列 i の 7 点(南→北の順)。
const rowOf = (values, j) => Array.from({ length: NODE_COUNT }, (_, i) => values[j * NODE_COUNT + i]);
const colOf = (values, i) => Array.from({ length: NODE_COUNT }, (_, k) => values[(NODE_COUNT - 1 - k) * NODE_COUNT + i]);

// 節点の量の (∂/∂x, ∂/∂y) [単位/km]。y は北向き。戻り値 { dx, dy } は節点の並びと同じ 49 要素。
export function gridGradient(values, spacing = NODE_SPACING_KM) {
  const dx = new Array(NODE_COUNT * NODE_COUNT).fill(null);
  const dy = new Array(NODE_COUNT * NODE_COUNT).fill(null);
  for (let j = 0; j < NODE_COUNT; j++) {
    lineFirstDerivative(rowOf(values, j), spacing).forEach((d, i) => (dx[j * NODE_COUNT + i] = d));
  }
  for (let i = 0; i < NODE_COUNT; i++) {
    // 列は南→北の順で微分し、北向きの微分に戻す。
    lineFirstDerivative(colOf(values, i), spacing).forEach((d, k) => {
      dy[(NODE_COUNT - 1 - k) * NODE_COUNT + i] = d;
    });
  }
  return { dx, dy };
}

// 節点の量のラプラシアン ∂²/∂x² + ∂²/∂y² [単位/km²]。
export function gridLaplacian(values, spacing = NODE_SPACING_KM) {
  const out = new Array(NODE_COUNT * NODE_COUNT).fill(null);
  for (let j = 0; j < NODE_COUNT; j++) {
    lineSecondDerivative(rowOf(values, j), spacing).forEach((d, i) => {
      out[j * NODE_COUNT + i] = d;
    });
  }
  for (let i = 0; i < NODE_COUNT; i++) {
    lineSecondDerivative(colOf(values, i), spacing).forEach((d, k) => {
      const index = (NODE_COUNT - 1 - k) * NODE_COUNT + i;
      out[index] = out[index] == null || d == null ? null : out[index] + d;
    });
  }
  return out;
}

// 場面中心からの (xKm, yKm) の双線形補間。4 隅のどれかが null なら null。節点の外は例外にする。
export function gridBilinear(values, xKm, yKm, spacing = NODE_SPACING_KM) {
  const fi = xKm / spacing + CENTER;
  const fj = CENTER - yKm / spacing;
  const max = NODE_COUNT - 1;
  if (fi < 0 || fi > max || fj < 0 || fj > max) throw new RangeError(`節点の外: (${xKm}, ${yKm}) km`);
  const i0 = Math.min(Math.floor(fi), max - 1);
  const j0 = Math.min(Math.floor(fj), max - 1);
  const tx = fi - i0;
  const ty = fj - j0;
  const v00 = values[j0 * NODE_COUNT + i0];
  const v10 = values[j0 * NODE_COUNT + i0 + 1];
  const v01 = values[(j0 + 1) * NODE_COUNT + i0];
  const v11 = values[(j0 + 1) * NODE_COUNT + i0 + 1];
  if ([v00, v10, v01, v11].some((v) => v == null)) return null;
  return (1 - ty) * ((1 - tx) * v00 + tx * v10) + ty * ((1 - tx) * v01 + tx * v11);
}

// 節点の量から、タイル中心 (xKm, yKm) の気象条件を導く。入力が null の量から決まる条件は null。
// slp は slpReference を引いた偏差 [hPa]、cyclonic は ∇²p [hPa/(1000 km)²](正 = 低気圧性)、
// lift は上昇が正の鉛直速度 [m/s]、advection は −V·∇T850 [K/日]、front は |∇T850| [K/100 km]、
// stability は θ700 − θ850 [K]、windLowDir・windUpDir は風の吹いていく向き(東から反時計回り [度])。
export function conditionsAt(nodes, xKm, yKm, { slpReference = 1013.25 } = {}) {
  const sample = (values) => gridBilinear(values, xKm, yKm);
  const slp = sample(nodes.slp);
  const cyclonic = sample(gridLaplacian(nodes.slp));
  const tGrad = gridGradient(nodes.t850);
  const dTdx = sample(tGrad.dx);
  const dTdy = sample(tGrad.dy);
  const u850 = sample(nodes.u850);
  const v850 = sample(nodes.v850);
  const u300 = sample(nodes.u300);
  const v300 = sample(nodes.v300);
  const theta = (t, p) => t * Math.pow(1000 / p, KAPPA);
  const t700 = sample(nodes.t700);
  const t850 = sample(nodes.t850);
  const direction = (u, v) => (((Math.atan2(v, u) * 180) / Math.PI) % 360 + 360) % 360;

  return {
    slp: slp == null ? null : slp - slpReference,
    // ∇²p は [hPa/km²] なので 10⁶ 倍して [hPa/(1000 km)²] へ。
    cyclonic: cyclonic == null ? null : cyclonic * 1e6,
    lift: sample(nodes.w500),
    advection:
      dTdx == null || dTdy == null || u850 == null || v850 == null
        ? null
        : -(u850 * dTdx + v850 * dTdy) * 1e-3 * 86400,
    front: dTdx == null || dTdy == null ? null : Math.hypot(dTdx, dTdy) * 100,
    humidLow: sample(nodes.rh700),
    humidUp: sample(nodes.rh300),
    stability: t700 == null || t850 == null ? null : theta(t700, 700) - theta(t850, 850),
    windLow: u850 == null ? null : Math.hypot(u850, v850),
    windLowDir: u850 == null ? null : direction(u850, v850),
    windUp: u300 == null ? null : Math.hypot(u300, v300),
    windUpDir: u300 == null ? null : direction(u300, v300),
    shear: u850 == null || u300 == null ? null : Math.hypot(u300 - u850, v300 - v850),
  };
}
