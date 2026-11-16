// 天気図へ前線と低・高気圧の記号を置く。前線は谷の骨格(front-skeleton.ts)の背骨を
// 折れ線として引く — 場から稜を拾うのではなく、低気圧が持つ寒冷・温暖・閉塞の腕を
// そのまま引くので、線は必ず低気圧へ繋がり、閉塞の進みと同じ形になる。中心は L / H と
// 気圧値、眼を持つ渦は中心に眼の印を置く。
import { eyeStrengthOf } from '../../src/render/earth-weather/pressure-feature';
import {
  frontSpinesOf, frontStrengthOf,
} from '../../src/render/earth-weather/front-skeleton';
import { cyclonePlacementsAt } from '../../src/render/earth-weather/cyclone-tracks';
import { HIGH_COUNT, highPlacementAt } from '../../src/render/earth-weather/anticyclone-tracks';
import { R_EARTH, SIDEREAL_DAY } from '../../src/game/celestial/solar-system/earth-system';
import { strokeWrapped } from './synoptic-map';
import type { MapView } from './synoptic-map';
import type { FrontSpine, SpinePoint } from '../../src/render/earth-weather/front-skeleton';
import type { PressurePlacement } from '../../src/render/earth-weather/tracks';
import type { SynopticFields } from './synoptic-field';

// ── 前線 ────────────────────────────────────────────────────────────────

// 記号を置く間隔(折れ線の点の何個ごとに置くか)と大きさ [px]。
const SYMBOL_EVERY = 4;
const TRIANGLE_SIZE = 10;
const SEMICIRCLE_SIZE = 7;
// 前線の色 — 寒冷=青、温暖=赤、オクルード=紫。
const COLD_COLOR = '80, 140, 255';
const WARM_COLOR = '255, 100, 82';
const OCCLUDED_COLOR = '190, 120, 255';
// この強さ未満の前線は引かない — 生まれたての弱い谷の帯は滲んで見えない分だけ
// 天気図へも載せない。
const FRONT_DRAW_MIN = 0.05;

// 前線 1 連なりを塗る。記号は線へ乗せ、三角は頂点・半円は膨らみが前線の進む側を向く。
// 記号の向く側は背骨の +θ 法線(循環側) — 寒冷は暖域へ、温暖は寒域へ、閉塞は進行側へ
// 向く向きそのもの。
function strokeFront(
  context: CanvasRenderingContext2D, points: readonly SpinePoint[],
  kind: FrontSpine['kind'], strength: number, view: MapView,
): void {
  // 経度は前の点の近くへ畳み、先頭を窓の西端基準の一周へ畳む — 折れ線が日付変更線を
  // またいでも切れず、何周分も回り込んだ配置でも窓へ届く。
  const canvasPoints: [number, number][] = [];
  let previous: number | null = null;
  for (const point of points) {
    const lonDeg: number = previous === null
      ? view.lonMinDeg + (((point.longitude - view.lonMinDeg) % 360) + 360) % 360
      : previous + (((point.longitude - previous + 180) % 360) + 360) % 360 - 180;
    previous = lonDeg;
    canvasPoints.push([view.lonToX(lonDeg), view.latToY(point.latitude)]);
  }
  const color = kind === 'cold' ? COLD_COLOR : kind === 'warm' ? WARM_COLOR : OCCLUDED_COLOR;
  const line = new Path2D();
  for (const [index, [x, y]] of canvasPoints.entries()) {
    if (index === 0) line.moveTo(x, y);
    else line.lineTo(x, y);
  }
  // 帯の濃さは谷の深さに比例する — 浅い谷の前線は天気図でも薄い。
  const alpha = 0.3 + 0.6 * strength;
  strokeWrapped(context, view, () => {
    context.lineWidth = 2.4;
    context.strokeStyle = `rgba(${color}, ${alpha})`;
    context.stroke(line);
  });
  // 記号。法線は背骨が持つ循環側(+θ)の向き — canvas の y が南なので北向き成分を反転する。
  strokeWrapped(context, view, () => {
    const triangles = new Path2D();
    const semicircles = new Path2D();
    for (const [index, point] of points.entries()) {
      if (index % SYMBOL_EVERY !== 0) continue;
      const [x, y] = canvasPoints[index]!;
      const angle = Math.atan2(-point.ny, point.nx);
      const isTriangle = kind === 'cold'
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
    context.fillStyle = `rgba(${color}, ${alpha + 0.05})`;
    context.fill(triangles);
    context.fill(semicircles);
  });
}

// 前線をまとめて引く。前線を持つ谷それぞれについて骨格の背骨を取り、腕ごとに塗る。
// 背骨の芯は L の記号と同じく、配置の半径以内で場がいちばん低い所へ置く — 記号と
// 前線と等圧線の芯がひとつに見える。
function drawFronts(
  context: CanvasRenderingContext2D, fields: SynopticFields,
  cyclones: readonly (PressurePlacement | null)[], view: MapView,
): void {
  const placements: PressurePlacement[] = [];
  for (const placement of cyclones) {
    if (placement !== null) placements.push(placement);
  }
  for (const placement of placements) {
    // 記号が立てないほど浅い谷の前線は引かない — 深さ 5〜9 hPa で滲ませて、
    // 埋まる・生まれる境で線が跳ばないようにする。
    const t = Math.min(Math.max((placement.depth - 5) / 4, 0), 1);
    const strength = frontStrengthOf(placement) * t * t * (3 - 2 * t);
    if (strength < FRONT_DRAW_MIN) continue;
    const anchor = fieldExtremeNear(fields, placement, -1);
    // frontSpinesOf は緯度・経度をラジアンで受ける — 場の極値は度で返るので畳み直す。
    const anchorRad = {
      latitude: anchor.latitude * Math.PI / 180,
      longitude: anchor.longitude * Math.PI / 180,
    };
    for (const spine of frontSpinesOf(placement, R_EARTH, SIDEREAL_DAY, anchorRad)) {
      strokeFront(context, spine.points, spine.kind, strength, view);
    }
  }
}

// ── 中心の記号 ────────────────────────────────────────────────────────────

// 中心の記号を立てる深さ [hPa]。等圧線 2 本分 — これより浅い谷・山は閉じた等圧線を
// 作れず、記号だけが場と関係ない所へ立つ。
const LABEL_DEPTH_MIN = 8;

// 配置の芯のまわりで場がいちばん低い(高い)所を返す。谷・山の配置は場へ焼かれているが、
// 騒音が加わると実際の極値は配置の芯からずれる — 記号が等圧線の芯から離れて立たない
// よう、配置の半径の内側で極値を探してそこへ置き直す。sign は低気圧で -1、高気圧で +1。
function fieldExtremeNear(
  fields: SynopticFields, placement: PressurePlacement, sign: -1 | 1,
): { latitude: number; longitude: number; pressure: number } {
  const latDeg = placement.latitude * 180 / Math.PI;
  const lonDeg = placement.longitude * 180 / Math.PI;
  // 探す範囲は配置の半径の半分あまり [°] — 谷の寄与が効いている内側に留めて、
  // 騒音の極値へ跳ばないようにする。経度方向は緯度のコサインで広げる。
  const latSpan = 0.55 * (placement.radius / R_EARTH) * 180 / Math.PI;
  const lonSpan = Math.min(60, latSpan / Math.max(0.3, Math.cos(placement.latitude)));
  const cellLon = 360 / fields.width;
  const cellLat = 180 / fields.height;
  const lonCells = Math.ceil(lonSpan / cellLon);
  const latCells = Math.ceil(latSpan / cellLat);
  const cx = ((lonDeg + 180) / 360) * fields.width;
  const cy = ((90 - latDeg) / 180) * fields.height;
  let best = -Infinity;
  let bestX = Math.round(cx);
  let bestY = Math.round(cy);
  for (let dy = -latCells; dy <= latCells; dy += 1) {
    const y = Math.round(cy + dy);
    if (y < 0 || y >= fields.height) continue;
    for (let dx = -lonCells; dx <= lonCells; dx += 1) {
      const x = ((Math.round(cx + dx) % fields.width) + fields.width) % fields.width;
      const value = sign * fields.pressure[y * fields.width + x]!;
      if (value > best) {
        best = value;
        bestX = x;
        bestY = y;
      }
    }
  }
  return {
    latitude: 90 - (bestY + 0.5) * cellLat,
    longitude: (bestX + 0.5) * cellLon - 180,
    pressure: sign * best,
  };
}

// 中心の記号。mark(L / H)と気圧値、眼を持つなら眼の印。記号は配置の芯ではなく、
// 芯の半径以内で実際にいちばん低い(高い)場の点へ置く — 配置の経度は畳まずに持つので、
// 窓の西端を基準に一周(360°)で畳んでから画素へ写す — 時刻を大きく進めると配置の経度は
// 何周分も回り込み、畳まないままでは窓へ届かない。
function drawCenterLabel(
  context: CanvasRenderingContext2D, fields: SynopticFields,
  placement: PressurePlacement, mark: 'L' | 'H', eyeStrength: number, view: MapView,
): void {
  const extreme = fieldExtremeNear(fields, placement, mark === 'L' ? -1 : 1);
  const longitudeDeg = view.lonMinDeg
    + (((extreme.longitude - view.lonMinDeg) % 360) + 360) % 360;
  const x = view.lonToX(longitudeDeg);
  const y = view.latToY(extreme.latitude);
  const pressure = Math.round(1013 + extreme.pressure);
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
  const { tropicals, lows } = cyclonePlacementsAt(seconds, R_EARTH, SIDEREAL_DAY);
  // 前線は中心の記号の下へ引く。
  drawFronts(context, fields, [...lows, ...tropicals], view);
  // 温帯低気圧 — L。
  for (const placement of lows) {
    if (placement === null || placement.depth < LABEL_DEPTH_MIN) continue;
    drawCenterLabel(context, fields, placement, 'L', 0, view);
  }
  // 熱帯低気圧 — L と眼。
  for (const tropical of tropicals) {
    if (tropical === null || tropical.depth < LABEL_DEPTH_MIN) continue;
    const eye = eyeStrengthOf(
      tropical.depth, tropical.radius, tropical.latitude, R_EARTH, SIDEREAL_DAY);
    drawCenterLabel(context, fields, tropical, 'L', eye, view);
  }
  // 高気圧 — H。
  for (let index = 0; index < HIGH_COUNT; index += 1) {
    const high = highPlacementAt(index, seconds, R_EARTH);
    if (high === null || high.depth < LABEL_DEPTH_MIN) continue;
    drawCenterLabel(context, fields, high, 'H', 0, view);
  }
}
