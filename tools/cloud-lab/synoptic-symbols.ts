// 天気図へ前線と低・高気圧の記号を置く。前線は谷の骨格(front-skeleton.ts)の背骨を
// 折れ線として引く — 場から稜を拾うのではなく、低気圧が持つ寒冷・温暖・閉塞の腕を
// そのまま引くので、線は必ず低気圧へ繋がり、閉塞の進みと同じ形になる。中心は L / H と
// 気圧値、眼を持つ渦は中心に眼の印を置く。
import { eyeStrengthOf } from '../../src/render/earth-weather/pressure-feature';
import {
  frontSpinesOf, frontStrengthOf,
} from '../../src/render/earth-weather/front-skeleton';
import { LOW_COUNT, lowPlacementAt } from '../../src/render/earth-weather/low-tracks';
import { TROPICAL_COUNT, tropicalPlacementAt } from '../../src/render/earth-weather/tropical-tracks';
import { HIGH_COUNT, highPlacementAt } from '../../src/render/earth-weather/anticyclone-tracks';
import { R_EARTH, SIDEREAL_DAY } from '../../src/game/celestial/solar-system/earth-system';
import { sampleField, strokeWrapped } from './synoptic-map';
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
  kind: FrontSpine['kind'], view: MapView,
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
  strokeWrapped(context, view, () => {
    context.lineWidth = 2.4;
    context.strokeStyle = `rgba(${color}, 0.85)`;
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
    context.fillStyle = `rgba(${color}, 0.9)`;
    context.fill(triangles);
    context.fill(semicircles);
  });
}

// 前線をまとめて引く。前線を持つ谷それぞれについて骨格の背骨を取り、腕ごとに塗る。
function drawFronts(
  context: CanvasRenderingContext2D, seconds: number, view: MapView,
): void {
  const placements: PressurePlacement[] = [];
  for (let index = 0; index < LOW_COUNT; index += 1) {
    const placement = lowPlacementAt(index, seconds, R_EARTH);
    if (placement !== null) placements.push(placement);
  }
  for (let index = 0; index < TROPICAL_COUNT; index += 1) {
    const placement = tropicalPlacementAt(index, seconds);
    if (placement !== null) placements.push(placement);
  }
  for (const placement of placements) {
    if (frontStrengthOf(placement) < FRONT_DRAW_MIN) continue;
    for (const spine of frontSpinesOf(placement, R_EARTH)) {
      strokeFront(context, spine.points, spine.kind, view);
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
  drawFronts(context, seconds, view);
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
