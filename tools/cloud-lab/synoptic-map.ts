// 天気図の面を 2D canvas へ描く。synoptic-field が読み戻した全球の面(0.5° 刻みの正距円筒)
// から、気圧の塗り・等圧線・上層の流線・地表の風矢印・偏西風の蛇行の軸を引き、
// 海岸線と経緯線で座標を示す。見せる範囲は MapView(中心と半径で決まる窓)で、全層が同じ窓を使う。
import { EARTH_COASTLINE, R_EARTH } from '../../src/game/celestial/solar-system/earth-system';
import { WAVE_NUMBER, WAVE_PHASE_RATE } from '../../src/render/cloud/rossby-wave';
import type { SynopticFields } from './synoptic-field';

export const MAP_WIDTH = 1440;
export const MAP_HEIGHT = 720;

// 重ねる層の選び方。
export interface SynopticLayers {
  readonly fill: boolean; // 偏差気圧の塗り(青=谷・赤=丘)
  readonly coast: boolean; // 海岸線と経緯線
  readonly isobars: boolean; // 等圧線
  readonly streamlines: boolean; // 上層の流線
  readonly surfaceWind: boolean; // 地表の風矢印
  readonly wave: boolean; // 偏西風の蛇行の軸
  readonly symbols: boolean; // 前線と L / H の記号(synoptic-symbols が描く)
}

export const DEFAULT_LAYERS: SynopticLayers = {
  fill: true, coast: true, isobars: true, streamlines: true, surfaceWind: false,
  wave: true, symbols: true,
};

// 見る範囲。中心の緯度・経度と角半径 [°]。写しの cap と天気図の窓がそれぞれ持つ。
export interface Framing {
  readonly latitude: number;
  readonly longitude: number;
  readonly radius: number;
}
export const MAX_RADIUS_DEG = 90;
// 天気図の既定の窓。中心を赤道・本初子午線に置いて角半径を最大にすると、地球全体になる。
export const GLOBE: Framing = { latitude: 0, longitude: 0, radius: MAX_RADIUS_DEG };

// 地図に出す窓 — 中心の経度・緯度と角半径 [°] から、見せる経度・緯度の範囲と画素への写像を組む。
// 窓の経度幅は緯度幅の 2 倍(正距円筒の天地比に合わせる)で、半径 90° で全球になる。
// lonToX は窓の左端を 0 とする伸ばしたままの経度を受ける(窓の外へ出た分は canvas の端で切れる)。
export interface MapView {
  readonly lonMinDeg: number; // 窓の西端の経度(畳まない)
  readonly lonSpanDeg: number;
  readonly latMaxDeg: number; // 窓の北端の緯度
  readonly latSpanDeg: number;
  // 経度の一周(360°)ぶんの画素幅。日付変更線をまたぐ線をずらして引き直す量。
  readonly wrapWidthPx: number;
  lonToX(lonDeg: number): number;
  latToY(latDeg: number): number;
}

export function mapViewAt(centerLonDeg: number, centerLatDeg: number, radiusDeg: number): MapView {
  const latSpan = Math.min(180, radiusDeg * 2);
  const lonSpan = Math.min(360, latSpan * 2);
  // 窓が極を出ないよう中心を押し込む。端が極へ着いた窓はそれ以上動かない。
  const latMax = Math.max(-90 + latSpan, Math.min(90, centerLatDeg + latSpan / 2));
  const lonMin = centerLonDeg - lonSpan / 2;
  return {
    lonMinDeg: lonMin,
    lonSpanDeg: lonSpan,
    latMaxDeg: latMax,
    latSpanDeg: latSpan,
    wrapWidthPx: 360 * (MAP_WIDTH / lonSpan),
    lonToX: (lonDeg) => (lonDeg - lonMin) * (MAP_WIDTH / lonSpan),
    latToY: (latDeg) => (latMax - latDeg) * (MAP_HEIGHT / latSpan),
  };
}

// 経度をまたぐ線を、ずらした 3 写しで切れ目なく引く。ずらす量は経度一周ぶんの画素幅。
export function strokeWrapped(context: CanvasRenderingContext2D, view: MapView, draw: () => void): void {
  for (const offset of [-view.wrapWidthPx, 0, view.wrapWidthPx]) {
    context.save();
    context.translate(offset, 0);
    draw();
    context.restore();
  }
}

// 面の画素格子での値を、緯度経度 [rad] から双線形で拾う。経度は端を回り、緯度は端に留まる。
export function sampleField(channel: Float32Array, width: number, height: number,
  longitudeRad: number, latitudeRad: number): number {
  const u = ((longitudeRad + Math.PI) / (2 * Math.PI)) * width - 0.5;
  const v = ((Math.PI / 2 - latitudeRad) / Math.PI) * height - 0.5;
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const fx = u - x0;
  const fy = v - y0;
  const column = (x: number): number => ((x % width) + width) % width;
  const row = (y: number): number => Math.max(0, Math.min(height - 1, y));
  const c0 = column(x0);
  const c1 = column(x0 + 1);
  const r0 = row(y0);
  const r1 = row(y0 + 1);
  const a = channel[r0 * width + c0]!;
  const b = channel[r0 * width + c1]!;
  const c = channel[r1 * width + c0]!;
  const d = channel[r1 * width + c1]!;
  return a + (b - a) * fx + (c + (d - c) * fx - a - (b - a) * fx) * fy;
}

// ── 気圧の塗り ────────────────────────────────────────────────────────────

// 偏差気圧の色止め [hPa]。下限側(深い谷)は −70 級まで見るので色は外へ張り付く。
export const PRESSURE_LOW_HPA = -50;
export const PRESSURE_HIGH_HPA = 35;

export function pressureColor(p: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, (p - PRESSURE_LOW_HPA) / (PRESSURE_HIGH_HPA - PRESSURE_LOW_HPA)));
  // 3 止め: 深い谷の青 → 0 まわりの暗い中間 → 高い丘のくすんだ赤。地図の主役は線と
  // 記号なので、丘側は彩度を落として背景に留める。
  if (t < 0.5) {
    const s = t * 2;
    return [30 + (22 - 30) * s, 62 + (26 - 62) * s, 150 + (34 - 150) * s];
  }
  const s = (t - 0.5) * 2;
  return [22 + (118 - 22) * s, 26 + (48 - 26) * s, 34 + (42 - 34) * s];
}

// 偏差気圧の色を画素へ焼いた画像。面が変わったときだけ組み直し、窓や層を変えるたびには組まない。
let pressureImage: { readonly source: Float32Array; readonly canvas: HTMLCanvasElement } | null = null;

function pressureCanvasOf(fields: SynopticFields): HTMLCanvasElement {
  const cached = pressureImage?.canvas;
  if (pressureImage?.source === fields.pressure && cached?.width === fields.width && cached.height === fields.height) {
    return cached;
  }
  const canvas = document.createElement('canvas');
  canvas.width = fields.width;
  canvas.height = fields.height;
  const fill = canvas.getContext('2d')!;
  const image = fill.createImageData(fields.width, fields.height);
  const px = image.data;
  for (let i = 0; i < fields.width * fields.height; i += 1) {
    const [r, g, b] = pressureColor(fields.pressure[i]!);
    px[i * 4] = r;
    px[i * 4 + 1] = g;
    px[i * 4 + 2] = b;
    px[i * 4 + 3] = 255;
  }
  fill.putImageData(image, 0, 0);
  pressureImage = { source: fields.pressure, canvas };
  return canvas;
}

// 偏差気圧を青(谷)と赤(丘)の塗りで敷き、窓の写す矩形を切り出して貼る。
// 経度の継ぎ目を跨ぐ窓は 2 枚へ分けて貼る。
function drawFill(context: CanvasRenderingContext2D, fields: SynopticFields, view: MapView): void {
  const fillCanvas = pressureCanvasOf(fields);
  const srcW = (view.lonSpanDeg / 360) * fields.width;
  const srcH = (view.latSpanDeg / 180) * fields.height;
  const srcY = ((90 - view.latMaxDeg) / 180) * fields.height;
  const srcX = ((view.lonMinDeg + 180) % 360 + 360) % 360 / 360 * fields.width;
  context.imageSmoothingEnabled = true;
  if (srcX + srcW <= fields.width) {
    context.drawImage(fillCanvas, srcX, srcY, srcW, srcH, 0, 0, MAP_WIDTH, MAP_HEIGHT);
  } else {
    const firstW = fields.width - srcX;
    const split = (firstW / srcW) * MAP_WIDTH;
    context.drawImage(fillCanvas, srcX, srcY, firstW, srcH, 0, 0, split, MAP_HEIGHT);
    context.drawImage(fillCanvas, 0, srcY, srcW - firstW, srcH, split, 0, MAP_WIDTH - split, MAP_HEIGHT);
  }
}

// ── 等圧線 ────────────────────────────────────────────────────────────────

const ISOBAR_STEP_HPA = 4;
const ISOBAR_BOLD_HPA = 20;
const MSLP_HPA = 1013;

// セルの角の並び(TL, TR, BR, BL)に対する等値線の切り方。各辺の端の番号は
// 上=0・右=1・下=2・左=3 — 中身は「どの辺とどの辺を結ぶか」の対。
const MARCHING_EDGES: readonly (readonly [number, number])[][] = [
  [],
  [[0, 3]],
  [[0, 1]],
  [[1, 3]],
  [[1, 2]],
  [],
  [[0, 2]],
  [[2, 3]],
  [[2, 3]],
  [[0, 2]],
  [],
  [[1, 2]],
  [[1, 3]],
  [[0, 1]],
  [[0, 3]],
  [],
];

// 辺の内挿の向き。edgePoint の f=0 側の角は辺ごとに違う(上=TL・右=TR・下=BL・左=TL)ので、
// 端の対を辺の番号から引く。
const EDGE_CORNERS = [[0, 1], [1, 2], [3, 2], [0, 3]] as const;

// 面の画素格子へ等圧線をマーチングスクエアで切る。値は海上気圧 [hPa] = 1013 + 偏差。
// 経度は端で回るので、窓の写す列を畳まない列番号 u で走り、画素列は u % width で拾う。
function drawIsobars(context: CanvasRenderingContext2D, fields: SynopticFields, view: MapView): void {
  const { width, height, pressure } = fields;
  const thin = new Path2D();
  const bold = new Path2D();
  // 窓が写す格子の範囲 — 列 u は畳まない(画素へは mod で読む)。1 格子ぶんの画素幅を取る。
  const pxPerCellX = (360 / width) * (MAP_WIDTH / view.lonSpanDeg);
  const pxPerCellY = (180 / height) * (MAP_HEIGHT / view.latSpanDeg);
  const xMinF = ((view.lonMinDeg + 180) / 360) * width;
  const yMinF = ((90 - view.latMaxDeg) / 180) * height;
  const uMax = Math.ceil(xMinF + (view.lonSpanDeg / 360) * width);
  const vMax = Math.min(height - 1, Math.ceil(yMinF + (view.latSpanDeg / 180) * height));
  // 辺の内挿点を画素へ返す。edge は上0・右1・下2・左3。
  const edgePoint = (u: number, v: number, edge: number, f: number): [number, number] => {
    const [gx, gy] = edge === 0 ? [u + f, v] : edge === 1 ? [u + 1, v + f]
      : edge === 2 ? [u + f, v + 1] : [u, v + f];
    return [(gx - xMinF) * pxPerCellX, (gy - yMinF) * pxPerCellY];
  };
  for (let v = Math.max(0, Math.floor(yMinF)); v < vMax; v += 1) {
    for (let u = Math.floor(xMinF); u < uMax; u += 1) {
      const x = ((u % width) + width) % width;
      const x1 = (x + 1) % width;
      const p00 = MSLP_HPA + pressure[v * width + x]!;
      const p10 = MSLP_HPA + pressure[v * width + x1]!;
      const p01 = MSLP_HPA + pressure[(v + 1) * width + x]!;
      const p11 = MSLP_HPA + pressure[(v + 1) * width + x1]!;
      // このセルを通る等圧線の値だけを角の幅から拾う。
      const low = Math.ceil(Math.min(p00, p10, p01, p11) / ISOBAR_STEP_HPA) * ISOBAR_STEP_HPA;
      const high = Math.floor(Math.max(p00, p10, p01, p11) / ISOBAR_STEP_HPA) * ISOBAR_STEP_HPA;
      for (let level = low; level <= high; level += ISOBAR_STEP_HPA) {
        const over = (p: number): number => (p >= level ? 1 : 0);
        const corners = [p00, p10, p11, p01];
        const code = over(p00) | (over(p10) << 1) | (over(p11) << 2) | (over(p01) << 3);
        // 鞍(corners が交互)は中央値で切る方を決める。
        let edges = MARCHING_EDGES[code]!;
        if (code === 5 || code === 10) {
          const center = (p00 + p10 + p11 + p01) / 4;
          const merged = center >= level;
          edges = code === 5
            ? (merged ? [[0, 1], [2, 3]] : [[0, 3], [1, 2]])
            : (merged ? [[0, 3], [1, 2]] : [[0, 1], [2, 3]]);
        }
        // 辺の端を値で内挿する。両端が等しい辺は切れない(退化セル)ので null で落とす。
        const from = (edge: number): [number, number] | null => {
          const [a, b] = EDGE_CORNERS[edge]!;
          const span = corners[b]! - corners[a]!;
          if (span === 0) return null;
          return edgePoint(u, v, edge, (level - corners[a]!) / span);
        };
        const target = level % ISOBAR_BOLD_HPA === 0 ? bold : thin;
        for (const [e0, e1] of edges) {
          const a = from(e0);
          const b = from(e1);
          if (a === null || b === null) continue;
          target.moveTo(a[0], a[1]);
          target.lineTo(b[0], b[1]);
        }
      }
    }
  }
  context.strokeStyle = 'rgba(210, 222, 235, 0.35)';
  context.lineWidth = 0.8;
  context.stroke(thin);
  context.strokeStyle = 'rgba(215, 228, 242, 0.62)';
  context.lineWidth = 1.5;
  context.stroke(bold);
}

// ── 上層の流線 ────────────────────────────────────────────────────────────

// 流線の種の刻み [°] と、1 歩の長さ [m]・最大歩数。
const STREAM_SEED_LAT = 8;
const STREAM_SEED_LON = 14;
const STREAM_STEP_M = 140e3;
const STREAM_STEPS = 64;
// この速さを切ったら線を切る — 淀んだ所で線が玉にならないように。
const STREAM_MIN_SPEED = 4;

// 上層の風を種から流線として辿る。面の風は m/s — 緯度の進みは v/R、経度の進みは
// u/(R·cosφ) で、行き過ぎない刻みは速さで割る。種は窓の写す範囲へだけ蒔く。
function drawStreamlines(context: CanvasRenderingContext2D, fields: SynopticFields, view: MapView): void {
  const { width, height, upperWindEast, upperWindNorth } = fields;
  const latLo = Math.max(-72, view.latMaxDeg - view.latSpanDeg);
  const latHi = Math.min(72, view.latMaxDeg);
  for (let latDeg = latLo; latDeg <= latHi; latDeg += STREAM_SEED_LAT) {
    // 行ごとに経度を半間隔ずらして格子の目を崩す。
    const shift = (Math.round(latDeg / STREAM_SEED_LAT) % 2) * STREAM_SEED_LON * 0.5;
    for (let lonDeg = view.lonMinDeg + shift; lonDeg < view.lonMinDeg + view.lonSpanDeg; lonDeg += STREAM_SEED_LON) {
      let lat = (latDeg + STREAM_SEED_LAT * 0.5) * Math.PI / 180;
      let lon = (lonDeg + STREAM_SEED_LON * 0.5) * Math.PI / 180;
      const path = new Path2D();
      let speedSum = 0;
      let steps = 0;
      path.moveTo(view.lonToX(lon * 180 / Math.PI), view.latToY(lat * 180 / Math.PI));
      for (let step = 0; step < STREAM_STEPS; step += 1) {
        const u = sampleField(upperWindEast, width, height, lon, lat);
        const v = sampleField(upperWindNorth, width, height, lon, lat);
        const speed = Math.hypot(u, v);
        if (!(speed >= STREAM_MIN_SPEED) || Math.abs(lat) > 1.53) break;
        const dt = STREAM_STEP_M / speed;
        lat += (v * dt) / R_EARTH;
        lon += (u * dt) / (R_EARTH * Math.cos(lat));
        speedSum += speed;
        steps += 1;
        path.lineTo(view.lonToX(lon * 180 / Math.PI), view.latToY(lat * 180 / Math.PI));
      }
      if (steps === 0) continue;
      // 速いほど明るく太く — ジェットの芯と蛇行の山が読める。
      const mean = speedSum / steps;
      const alpha = 0.1 + Math.min(1, mean / 45) * 0.48;
      context.strokeStyle = `rgba(125, 195, 255, ${alpha.toFixed(3)})`;
      context.lineWidth = mean > 30 ? 1.2 : 0.7;
      // 日付変更線を越えて伸びた線は、ずらした写しで反対の端から入り直す。
      strokeWrapped(context, view, () => context.stroke(path));
    }
  }
}

// ── 地表の風矢印 ──────────────────────────────────────────────────────────

const WIND_ARROW_LON = 10;
const WIND_ARROW_LAT = 8;
// 矢印の長さの下限と、速さ 1 m/s あたりの伸び [px]、上限 [px]。
const WIND_ARROW_BASE = 5;
const WIND_ARROW_GAIN = 0.55;
const WIND_ARROW_MAX = 16;

function drawSurfaceWind(context: CanvasRenderingContext2D, fields: SynopticFields, view: MapView): void {
  const { width, height, surfaceWindEast, surfaceWindNorth } = fields;
  context.strokeStyle = 'rgba(205, 218, 235, 0.5)';
  context.lineWidth = 1;
  const path = new Path2D();
  const latLo = Math.max(-84, view.latMaxDeg - view.latSpanDeg);
  const latHi = Math.min(84, view.latMaxDeg);
  for (let latDeg = latLo; latDeg <= latHi; latDeg += WIND_ARROW_LAT) {
    for (let lonDeg = view.lonMinDeg; lonDeg < view.lonMinDeg + view.lonSpanDeg; lonDeg += WIND_ARROW_LON) {
      const lat = latDeg * Math.PI / 180;
      const lon = lonDeg * Math.PI / 180;
      const u = sampleField(surfaceWindEast, width, height, lon, lat);
      const v = sampleField(surfaceWindNorth, width, height, lon, lat);
      const speed = Math.hypot(u, v);
      if (speed < 1) continue;
      const length = Math.min(WIND_ARROW_MAX, WIND_ARROW_BASE + speed * WIND_ARROW_GAIN);
      // 風向は東・北の比だけ — 矢印は地図の軸に沿って向ける。
      const dx = u / speed;
      const dy = -v / speed;
      const cx = view.lonToX(lonDeg);
      const cy = view.latToY(latDeg);
      const tx = cx + dx * length;
      const ty = cy + dy * length;
      path.moveTo(cx, cy);
      path.lineTo(tx, ty);
      // 矢羽 — 進行方向へ 25° 開いた 2 本。
      for (const side of [-1, 1]) {
        const angle = Math.atan2(dy, dx) + side * 0.45;
        path.moveTo(tx, ty);
        path.lineTo(tx - Math.cos(angle) * 4.5, ty - Math.sin(angle) * 4.5);
      }
    }
  }
  context.stroke(path);
}

// ── 偏西風の蛇行 ────────────────────────────────────────────────────────

// ジェットの軸の緯度 [°] と、蛇行の見せる幅 [°]。幅はモデルの波から積分した値ではなく、
// 蛇行の様子を読みやすくする表示上の広げ方。
const JET_AXIS_LAT = 46;
const JET_MEANDER_AMPLITUDE = 8;

// ロスビー波に乗る上層ジェットの軸。流れが波の流線関数 ψ ∝ sin(kλ − ωt) に沿って進むと、
// 軸の緯度は谷(ψ の極小)で赤道側へ、尾根で極側へ振れる — 蛇行の形を波の位相から引く。
// 地表の低気圧・高気圧の配置もこの波の位相へ錨づくので、L / H と軸の凹凸は位置が揃う。
function drawJetMeander(context: CanvasRenderingContext2D, seconds: number, view: MapView): void {
  const path = new Path2D();
  for (const sign of [1, -1]) {
    let started = false;
    for (let lonDeg = view.lonMinDeg; lonDeg <= view.lonMinDeg + view.lonSpanDeg; lonDeg += 0.5) {
      const phase = (lonDeg * Math.PI / 180) * WAVE_NUMBER - WAVE_PHASE_RATE * seconds;
      const latitude = sign * (JET_AXIS_LAT + JET_MEANDER_AMPLITUDE * Math.sin(phase));
      const x = view.lonToX(lonDeg);
      const y = view.latToY(latitude);
      if (started) path.lineTo(x, y);
      else { path.moveTo(x, y); started = true; }
    }
  }
  context.strokeStyle = 'rgba(255, 195, 95, 0.8)';
  context.lineWidth = 1.8;
  context.stroke(path);
}

// ── 海岸線と経緯線 ────────────────────────────────────────────────────────

function drawCoastlines(context: CanvasRenderingContext2D, view: MapView): void {
  // 緯線経線は 30° ごとの細線、赤道だけ少し濃く。
  const graticule = new Path2D();
  const lonLo = Math.ceil(view.lonMinDeg / 30) * 30;
  for (let lon = lonLo; lon < view.lonMinDeg + view.lonSpanDeg; lon += 30) {
    const x = view.lonToX(lon);
    graticule.moveTo(x, 0);
    graticule.lineTo(x, MAP_HEIGHT);
  }
  const latLo = Math.ceil((view.latMaxDeg - view.latSpanDeg) / 30) * 30;
  for (let lat = latLo; lat <= view.latMaxDeg; lat += 30) {
    if (lat === 0) continue;
    const y = view.latToY(lat);
    graticule.moveTo(0, y);
    graticule.lineTo(MAP_WIDTH, y);
  }
  context.strokeStyle = 'rgba(255, 255, 255, 0.07)';
  context.lineWidth = 1;
  context.stroke(graticule);
  context.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  context.beginPath();
  context.moveTo(0, view.latToY(0));
  context.lineTo(MAP_WIDTH, view.latToY(0));
  context.stroke();

  // 海岸線 — Natural Earth 110m の折れ線(緯度・経度 [deg])。日付変更線をまたぐ点の対は
  // 切る — 伸ばした座標のまま繋ぐと地図を横断する直線になる。
  context.strokeStyle = 'rgba(155, 175, 190, 0.55)';
  context.lineWidth = 1;
  for (const polyline of EARTH_COASTLINE) {
    const path = new Path2D();
    let previousLon = 0;
    for (const [index, [lat, lon]] of polyline.entries()) {
      const x = view.lonToX(lon);
      const y = view.latToY(lat);
      if (index === 0 || Math.abs(lon - previousLon) > 180) path.moveTo(x, y);
      else path.lineTo(x, y);
      previousLon = lon;
    }
    strokeWrapped(context, view, () => context.stroke(path));
  }
}

// ── 入口 ─────────────────────────────────────────────────────────────────

// 面を地図へ描く。layers で重ねる層を選び、view で見せる窓を決める。seconds は波の位相を引く時刻 [s]。
export function drawSynoptic(
  context: CanvasRenderingContext2D, fields: SynopticFields, layers: SynopticLayers,
  seconds: number, view: MapView,
): void {
  if (layers.fill) drawFill(context, fields, view);
  else {
    context.fillStyle = '#10141a';
    context.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
  }
  // 流線は線の層のいちばん下 — 上へ重なる等圧線や記号を潰さないように先に引く。
  if (layers.streamlines) drawStreamlines(context, fields, view);
  if (layers.coast) drawCoastlines(context, view);
  if (layers.isobars) drawIsobars(context, fields, view);
  if (layers.wave) drawJetMeander(context, seconds, view);
  if (layers.surfaceWind) drawSurfaceWind(context, fields, view);
}
