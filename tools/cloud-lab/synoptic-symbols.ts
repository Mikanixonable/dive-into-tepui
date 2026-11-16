// 天気図へ前線と低・高気圧の記号を置く。前線は気団の圧縮が立つ稜として場から拾い、線を
// 横切る風の向きで寒冷・温暖・停滞を分け、閉塞の進んだ低気圧のそばは巻いた部分として
// オクルードにする。中心は L / H と気圧値、眼を持つ渦は中心に眼の印を置く。
import { CLOUD_TUNING } from '../../src/render/earth-weather/cloud/cloud-tuning';
import { eyeStrengthOf } from '../../src/render/earth-weather/pressure-feature';
import { LOW_COUNT, lowPlacementAt } from '../../src/render/earth-weather/low-tracks';
import { TROPICAL_COUNT, tropicalPlacementAt } from '../../src/render/earth-weather/tropical-tracks';
import { HIGH_COUNT, highPlacementAt } from '../../src/render/earth-weather/anticyclone-tracks';
import { R_EARTH, SIDEREAL_DAY } from '../../src/game/celestial/solar-system/earth-system';
import { sampleField, strokeWrapped } from './synoptic-map';
import type { MapView } from './synoptic-map';
import type { PressurePlacement } from '../../src/render/earth-weather/tracks';
import type { SynopticFields } from './synoptic-field';

// ── 前線 ────────────────────────────────────────────────────────────────

// 面の画素格子の点。x が経度(端で回る)、y が緯度(上が北)。
interface GridPoint {
  readonly x: number;
  readonly y: number;
}

// 前線の種別。寒冷・温暖は風が稜を横切る向きで分け、横切らなければ停滞、閉塞の進んだ
// 低気圧のそばはオクルード。
type FrontKind = 'cold' | 'warm' | 'stationary' | 'occluded';

// 稜の点とその分類。advance は法線 +n(接線を反時計へ 90° 回した側)を +1 とした、
// 記号が向く前線の進行側。nx・ny は法線の単位ベクトル(格子座標)。
interface ClassedPoint extends GridPoint {
  readonly kind: FrontKind;
  readonly advance: number;
  readonly nx: number;
  readonly ny: number;
}

// 前線帯が立ち始める緯度 [°] — モデルが帯へ掛ける温帯の門(weather-model.ts の
// FRONT_LATITUDE_START)と同じ値。熱帯では圧縮の稜は前線ではなく雨帯なので引かない。
const FRONT_LAT_MIN = 20;
// これより短い稜は引かない [画素]。0.5° 刻みなので 6 画素 ≈ 3° ≈ 330 km。
const MIN_FRONT_POINTS = 6;
// 同じ種別が続く最小の長さ [画素]。これより短い切れ目は両側へ畳む。
const MIN_RUN_POINTS = 4;
// 寒冷・温暖を分ける、線を横切る風の速さの下限 [m/s]。これ以下は停滞とする。
const CROSS_WIND_MIN = 1.5;
// 暖かい側を決めるために法線へ離す距離 [画素]。圧縮の稜の幅の外へ出る分。
const SIDE_OFFSET = 4;
// 閉塞した低気圧のそばとみなす、芯からの距離の短軸の半径に対する比。
const OCCLUDED_REACH = 1.1;
// 記号を置く間隔(折れ線の点の何個ごとに置くか)と大きさ [px]。
const SYMBOL_EVERY = 7;
const TRIANGLE_SIZE = 10;
const SEMICIRCLE_SIZE = 7;
// 前線の色 — 寒冷=青、温暖=赤、オクルード=紫。
const COLD_COLOR = '80, 140, 255';
const WARM_COLOR = '255, 100, 82';
const OCCLUDED_COLOR = '190, 120, 255';

// 面の画素格子での値を、画素座標から双線形で拾う。x は端を回り、y は端に留まる。
function gridAt(channel: Float32Array, width: number, height: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const column = (c: number): number => ((c % width) + width) % width;
  const row = (r: number): number => Math.max(0, Math.min(height - 1, r));
  const a = channel[row(y0) * width + column(x0)]!;
  const b = channel[row(y0) * width + column(x0 + 1)]!;
  const c = channel[row(y0 + 1) * width + column(x0)]!;
  const d = channel[row(y0 + 1) * width + column(x0 + 1)]!;
  return a + (b - a) * fx + (c + (d - c) * fx - a - (b - a) * fx) * fy;
}

// 画素座標を緯度経度 [deg] へ(面の画素の中心)。sampleField と同じ置き方。
const gridLongitude = (x: number, width: number): number => ((x + 0.5) / width) * 360 - 180;
const gridLatitude = (y: number, height: number): number => 90 - ((y + 0.5) / height) * 180;

// 圧縮の稜を辿って折れ線へ切る。稜の点は、圧縮が閾値(モデルの前線帯の開始と同じ)を
// 超え、勾配の向きの両側の隣より低くない点。閾値は調整値へ追従する。
function frontChains(fields: SynopticFields): GridPoint[][] {
  const { width, height, compression } = fields;
  const onset = CLOUD_TUNING.frontOnset.value;
  const ridge = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    if (Math.abs(gridLatitude(y, height)) < FRONT_LAT_MIN) continue;
    for (let x = 0; x < width; x += 1) {
      const center = compression[y * width + x]!;
      if (center < onset) continue;
      const east = compression[y * width + (x + 1) % width]!;
      const west = compression[y * width + (x - 1 + width) % width]!;
      const south = compression[(y + 1) * width + x]!;
      const north = compression[(y - 1) * width + x]!;
      const gx = east - west;
      const gy = south - north;
      const g = Math.hypot(gx, gy);
      // 勾配の消えた所は稜ではない — 広い平坦域がまるごと稜になるのを防ぐ。
      if (g < 1e-4) continue;
      const nx = gx / g;
      const ny = gy / g;
      if (center >= gridAt(compression, width, height, x + nx, y + ny)
        && center >= gridAt(compression, width, height, x - nx, y - ny)) {
        ridge[y * width + x] = 1;
      }
    }
  }
  // 稜の点を 8 近傍で繋いで折れ線へ。両方向へ未訪問の隣を貪欲に伸ばす。
  const visited = new Uint8Array(width * height);
  const neighborAt = (point: GridPoint): GridPoint | null => {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        const y = point.y + dy;
        if (y < 1 || y >= height - 1) continue;
        const x = (point.x + dx + width) % width;
        if (ridge[y * width + x] === 1 && visited[y * width + x] === 0) return { x, y };
      }
    }
    return null;
  };
  const chains: GridPoint[][] = [];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (ridge[y * width + x] === 0 || visited[y * width + x] === 1) continue;
      const chain: GridPoint[] = [{ x, y }];
      visited[y * width + x] = 1;
      for (;;) {
        const next = neighborAt(chain[chain.length - 1]!);
        if (next === null) break;
        visited[next.y * width + next.x] = 1;
        chain.push(next);
      }
      for (;;) {
        const next = neighborAt(chain[0]!);
        if (next === null) break;
        visited[next.y * width + next.x] = 1;
        chain.unshift(next);
      }
      if (chain.length >= MIN_FRONT_POINTS) chains.push(chain);
    }
  }
  return chains;
}

// 折れ線の点ごとの前線の種別と進行方向。法線の両側で暖かい側を拾い、地表の風が稜を
// 冷たい側から暖かい側へ横切れば寒冷(記号は暖かい側へ向く)、逆なら温暖、横切ら
// なければ停滞。閉塞の進んだ低気圧のそばはどれより先にオクルードへ振る。
function classifyFront(
  fields: SynopticFields, chain: readonly GridPoint[],
  occludedLows: readonly { readonly x: number; readonly y: number; readonly reach: number }[],
): ClassedPoint[] {
  const { width, height, warmth, surfaceWindEast, surfaceWindNorth } = fields;
  return chain.map((point, index) => {
    const previous = chain[Math.max(0, index - 1)]!;
    const next = chain[Math.min(chain.length - 1, index + 1)]!;
    // 接線は経度の継ぎ目をまたぐと 360° 跳ぶので短い方へ畳む。
    let tx = next.x - previous.x;
    if (tx > width / 2) tx -= width;
    else if (tx < -width / 2) tx += width;
    const ty = next.y - previous.y;
    const length = Math.hypot(tx, ty) || 1;
    // 法線 — 格子の x が経度・y が南へ増える座標で、接線の反時計まわり側を +n とする。
    const nx = -ty / length;
    const ny = tx / length;
    // 閉塞 — 巻いた部分は芯の近くだけ。記号の向きは風の横切る側。
    for (const low of occludedLows) {
      const dx = Math.min(Math.abs(point.x - low.x), width - Math.abs(point.x - low.x));
      const dy = point.y - low.y;
      if (Math.hypot(dx, dy) < low.reach) {
        const east = gridAt(surfaceWindEast, width, height, point.x, point.y);
        const north = gridAt(surfaceWindNorth, width, height, point.x, point.y);
        const cross = east * nx - north * ny;
        return { ...point, kind: 'occluded', advance: Math.sign(cross) || 1, nx, ny };
      }
    }
    const warmPlus = gridAt(warmth, width, height, point.x + nx * SIDE_OFFSET, point.y + ny * SIDE_OFFSET);
    const warmMinus = gridAt(warmth, width, height, point.x - nx * SIDE_OFFSET, point.y - ny * SIDE_OFFSET);
    // 暖かい側が分からない(warmth は温帯の門の外では 0)稜は前線として分類できない — 
    // 停滞へ畳んで線だけ引く。
    if (Math.abs(warmPlus - warmMinus) < 1e-3) return { ...point, kind: 'stationary', advance: 1, nx, ny };
    const warmSide = Math.sign(warmPlus - warmMinus);
    // 風の法線成分。格子の x は経度=東、y は南へ増えるので北向きは −y。
    const east = gridAt(surfaceWindEast, width, height, point.x, point.y);
    const north = gridAt(surfaceWindNorth, width, height, point.x, point.y);
    const cross = (east * nx - north * ny) * warmSide;
    if (Math.abs(cross) < CROSS_WIND_MIN) return { ...point, kind: 'stationary', advance: warmSide, nx, ny };
    // 風が冷たい側から暖かい側へ横切る(寒気の進出)= 寒冷前線、記号は暖かい側。
    // 逆に暖かい側から冷たい側へ = 温暖前線、記号は冷たい側。
    return cross > 0
      ? { ...point, kind: 'cold', advance: warmSide, nx, ny }
      : { ...point, kind: 'warm', advance: -warmSide, nx, ny };
  });
}

// 点ごとの種別から同じ種別の連なりへ切る。短い連なりは隣へ畳む。
function frontRuns(points: readonly ClassedPoint[]):
  { readonly kind: FrontKind; readonly points: readonly ClassedPoint[] }[] {
  const runs: { kind: FrontKind; points: ClassedPoint[] }[] = [];
  for (const point of points) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === point.kind) last.points.push(point);
    else runs.push({ kind: point.kind, points: [point] });
  }
  // 短い連なりを前の連なりへ畳む(後ろから畳むと先頭が残るので先頭だけ後ろへ畳む)。
  const merged: { kind: FrontKind; points: ClassedPoint[] }[] = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last !== undefined && run.points.length < MIN_RUN_POINTS) last.points.push(...run.points);
    else merged.push({ kind: run.kind, points: [...run.points] });
  }
  const first = merged[0];
  const last = merged[merged.length - 1];
  if (merged.length > 1 && first !== undefined && last !== undefined
    && first.points.length < MIN_RUN_POINTS) {
    last.points.push(...first.points);
    merged.shift();
  }
  return merged;
}

// 前線 1 連なりを塗る。記号は線へ乗せ、三角は頂点・半円は膨らみが前線の進む側を向く。
// 停滞は青い三角と赤い半円を両側へ交互に置く。
function strokeFront(
  context: CanvasRenderingContext2D, points: readonly ClassedPoint[],
  kind: FrontKind, view: MapView, fields: SynopticFields,
): void {
  const canvasPoints = points.map((point): [number, number] => [
    view.lonToX(gridLongitude(point.x, fields.width)),
    view.latToY(gridLatitude(point.y, fields.height)),
  ]);
  const color = kind === 'cold' ? COLD_COLOR : kind === 'warm' ? WARM_COLOR : OCCLUDED_COLOR;
  const line = new Path2D();
  for (const [index, [x, y]] of canvasPoints.entries()) {
    if (index === 0) line.moveTo(x, y);
    else line.lineTo(x, y);
  }
  strokeWrapped(context, view, () => {
    context.lineWidth = 2.4;
    if (kind === 'stationary') {
      // 交互の青と赤 — 2 色の破線を重ねる。
      context.setLineDash([10, 10]);
      context.strokeStyle = `rgba(${COLD_COLOR}, 0.85)`;
      context.stroke(line);
      context.lineDashOffset = 10;
      context.strokeStyle = `rgba(${WARM_COLOR}, 0.85)`;
      context.stroke(line);
      context.setLineDash([]);
      context.lineDashOffset = 0;
    } else {
      context.strokeStyle = `rgba(${color}, 0.85)`;
      context.stroke(line);
    }
  });
  // 記号。法線は格子座標と canvas 座標で向きが同じ(x が経度=東、y が南で一致)ので
  // そのまま使える。advance で向ける側を選ぶ。停滞は advance の交互で両側へ置く。
  strokeWrapped(context, view, () => {
    const triangles = new Path2D();
    const semicircles = new Path2D();
    for (const [index, point] of points.entries()) {
      if (index % SYMBOL_EVERY !== 0) continue;
      const [x, y] = canvasPoints[index]!;
      const side = kind === 'stationary' ? (Math.floor(index / SYMBOL_EVERY) % 2 === 0 ? 1 : -1) : point.advance;
      const px = point.nx * side;
      const py = point.ny * side;
      const angle = Math.atan2(py, px);
      const isTriangle = kind === 'cold'
        || (kind === 'stationary' && Math.floor(index / SYMBOL_EVERY) % 2 === 0)
        || (kind === 'occluded' && Math.floor(index / SYMBOL_EVERY) % 2 === 0);
      if (isTriangle) {
        triangles.moveTo(x + Math.cos(angle) * TRIANGLE_SIZE, y + Math.sin(angle) * TRIANGLE_SIZE);
        triangles.lineTo(x + Math.cos(angle + 2.6) * TRIANGLE_SIZE * 0.7, y + Math.sin(angle + 2.6) * TRIANGLE_SIZE * 0.7);
        triangles.lineTo(x + Math.cos(angle - 2.6) * TRIANGLE_SIZE * 0.7, y + Math.sin(angle - 2.6) * TRIANGLE_SIZE * 0.7);
        triangles.closePath();
      } else {
        semicircles.moveTo(x + Math.cos(angle) * SEMICIRCLE_SIZE, y + Math.sin(angle) * SEMICIRCLE_SIZE);
        semicircles.arc(x, y, SEMICIRCLE_SIZE, angle, angle + Math.PI);
      }
    }
    if (kind === 'stationary') {
      context.fillStyle = `rgba(${COLD_COLOR}, 0.9)`;
      context.fill(triangles);
      context.fillStyle = `rgba(${WARM_COLOR}, 0.9)`;
      context.fill(semicircles);
    } else {
      context.fillStyle = `rgba(${color}, 0.9)`;
      context.fill(triangles);
      context.fill(semicircles);
    }
  });
}

// 前線をまとめて引く。圧縮の稜を折れ線へ切り、点ごとの種別で連なりに分けて塗る。
function drawFronts(
  context: CanvasRenderingContext2D, fields: SynopticFields, seconds: number, view: MapView,
): void {
  const { width, height } = fields;
  // 閉塞の進んだ低気圧の芯 — そばの稜はオクルードにする。半径は画素へ直す。
  const occludedLows: { readonly x: number; readonly y: number; readonly reach: number }[] = [];
  for (let index = 0; index < LOW_COUNT; index += 1) {
    const placement = lowPlacementAt(index, seconds, R_EARTH);
    if (placement === null || (placement.occlusion ?? 0) < 0.05) continue;
    const lonDeg = (((placement.longitude * 180 / Math.PI + 180) % 360) + 360) % 360 - 180;
    occludedLows.push({
      x: ((lonDeg + 180) / 360) * width - 0.5,
      y: ((90 - placement.latitude * 180 / Math.PI) / 180) * height - 0.5,
      reach: (placement.radius * OCCLUDED_REACH / R_EARTH) * (180 / Math.PI) * (width / 360),
    });
  }
  for (const chain of frontChains(fields)) {
    const classed = classifyFront(fields, chain, occludedLows);
    for (const run of frontRuns(classed)) {
      strokeFront(context, run.points, run.kind, view, fields);
    }
  }
}

// ── 中心の記号 ────────────────────────────────────────────────────────────

// 中心の記号。mark(L / H)と気圧値、眼を持つなら眼の印。配置の経度は畳まずに持つので、
// 窓の西端を基準に一周(360°)で畳んでから画素へ写す — 時刻を大きく進めると配置の経度は
// 何周分も回り込み、畳まないままでは窓へ届かない。
function drawCenterLabel(
  context: CanvasRenderingContext2D, fields: SynopticFields,
  placement: PressurePlacement, mark: 'L' | 'H', eyeStrength: number, view: MapView,
): void {
  const longitudeDeg = view.lonMinDeg
    + (((placement.longitude * 180 / Math.PI - view.lonMinDeg) % 360) + 360) % 360;
  const x = view.lonToX(longitudeDeg);
  const y = view.latToY(placement.latitude * 180 / Math.PI);
  // 中心の気圧は面から拾う。
  const pressure = Math.round(1013 + sampleField(
    fields.pressure, fields.width, fields.height,
    placement.longitude, placement.latitude));
  strokeWrapped(context, view, () => {
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = '700 26px "JetBrains Mono", ui-monospace, monospace';
    context.lineWidth = 4;
    context.strokeStyle = 'rgba(10, 13, 17, 0.85)';
    context.fillStyle = mark === 'L'
      ? 'rgba(255, 120, 100, 0.95)' : 'rgba(135, 175, 255, 0.95)';
    context.strokeText(mark, x, y);
    context.fillText(mark, x, y);
    context.font = '600 13px "JetBrains Mono", ui-monospace, monospace';
    context.strokeText(String(pressure), x, y + 20);
    context.fillText(String(pressure), x, y + 20);
    // 眼 — 開いているときだけ、中心に白い輪。
    if (eyeStrength > 0.4) {
      context.strokeStyle = `rgba(245, 250, 255, ${0.4 + 0.6 * eyeStrength})`;
      context.lineWidth = 2;
      context.beginPath();
      context.arc(x, y - 1, 7, 0, Math.PI * 2);
      context.stroke();
      context.fillStyle = 'rgba(12, 16, 22, 0.9)';
      context.beginPath();
      context.arc(x, y - 1, 3, 0, Math.PI * 2);
      context.fill();
    }
  });
}

// 前線と低・高気圧の記号をまとめて置く。seconds は現在時刻 [s]、view は地図の見せる窓。
export function drawCycloneSymbols(
  context: CanvasRenderingContext2D, fields: SynopticFields, seconds: number, view: MapView,
): void {
  // 前線は中心の記号の下へ引く。
  drawFronts(context, fields, seconds, view);
  // 温帯低気圧 — L。
  for (let index = 0; index < LOW_COUNT; index += 1) {
    const placement = lowPlacementAt(index, seconds, R_EARTH);
    if (placement === null || placement.depth < 2) continue;
    drawCenterLabel(context, fields, placement, 'L', 0, view);
  }
  // 熱帯低気圧 — L と眼。
  for (let index = 0; index < TROPICAL_COUNT; index += 1) {
    const tropical = tropicalPlacementAt(index, seconds);
    if (tropical === null || tropical.depth < 2) continue;
    const eye = eyeStrengthOf(
      tropical.depth, tropical.radius, tropical.latitude, R_EARTH, SIDEREAL_DAY);
    drawCenterLabel(context, fields, tropical, 'L', eye, view);
  }
  // 高気圧 — H。
  for (let index = 0; index < HIGH_COUNT; index += 1) {
    const high = highPlacementAt(index, seconds, R_EARTH);
    if (high === null || high.depth < 2) continue;
    drawCenterLabel(context, fields, high, 'H', 0, view);
  }
}
