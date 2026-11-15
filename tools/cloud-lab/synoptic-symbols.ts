// 天気図へ低・高気圧の記号を置く。温帯低気圧の前線はモデルと同じ局所座標の幾何
// (cyclones.ts の極曲線 φ = 方位 + 曲がり·rN、弦 ρ = rN × 半径/天体半径、渦向きが
// 両半球で φ 増大)で引き、寒冷は三角・温暖は半円・巻きは交互の三角と半円で飾る。
// 中心は L / H と気圧値、眼を持つ渦は中心に眼の印を置く。
import * as THREE from 'three/webgpu';
import {
  COLD_BEARING, COLD_CURVE, COLD_LENGTH, FRONT_DEPTH_HALF,
  WARM_BEARING, WARM_LENGTH, WARM_NARROW,
  WRAP_BEARING, WRAP_FULL, WRAP_ONSET, WRAP_RADIUS, WRAP_SPAN, WRAP_SPIRAL,
  eyeStrengthOf,
} from '../../src/render/cloud/cyclones';
import { LOW_COUNT, lowPlacementAt, tropicalPlacementAt } from '../../src/render/cloud/cyclone-tracks';
import { HIGH_COUNT, highPlacementAt } from '../../src/render/cloud/anticyclone-tracks';
import { R_EARTH, SIDEREAL_DAY } from '../../src/game/celestial/solar-system/earth-system';
import { sampleField, strokeWrapped } from './synoptic-map';
import type { MapView } from './synoptic-map';
import type { CyclonePlacement } from '../../src/render/cloud/cyclone-tracks';
import type { SynopticFields } from './synoptic-field';

// 腕の折れ線を切る範囲(半径の倍率) — モデルの帯芯の包絡が立つのは 0.4 から、
// 先端でほぼ消えるのは長さの 0.85 まで。
const ARM_START = 0.38;
const ARM_END = 0.85;
const ARM_POINTS = 56;
// 巻きの弧を引く方位幅(WRAP_SPAN に対する比)と折れ線の点数。
const WRAP_ARC_SPAN = 1.35;
const WRAP_ARC_POINTS = 48;
// 記号の間隔(折れ線の点の何個ごとに置くか)と大きさ [px]。
const SYMBOL_EVERY = 6;
const TRIANGLE_SIZE = 11;
const SEMICIRCLE_SIZE = 8;
// 前線の色 — 寒冷=青、温暖=赤、巻き=紫。
const COLD_COLOR = '80, 140, 255';
const WARM_COLOR = '255, 100, 82';
const WRAP_COLOR = '190, 120, 255';

// 低気圧の前線枠。Trough.place と同じ式で中心・東・極方向の単位方向を組む。
interface FrontFrame {
  readonly center: THREE.Vector3;
  readonly east: THREE.Vector3;
  readonly pole: THREE.Vector3;
  readonly radius: number; // 短軸の半径 [m]
  readonly strength: number; // 前線の強さ 0..1
  readonly life: number; // 一生の中の時期 0..1
}

function frontFrameOf(placement: CyclonePlacement): FrontFrame {
  const { latitude, longitude, depth, radius, life } = placement;
  const hemisphere = latitude >= 0 ? 1 : -1;
  const cosLatitude = Math.cos(latitude);
  const sinLatitude = Math.sin(latitude);
  const cosLongitude = Math.cos(longitude);
  const sinLongitude = Math.sin(longitude);
  return {
    center: new THREE.Vector3(cosLatitude * sinLongitude, sinLatitude, cosLatitude * cosLongitude),
    east: new THREE.Vector3(cosLongitude, 0, -sinLongitude),
    pole: new THREE.Vector3(
      -hemisphere * sinLatitude * sinLongitude,
      hemisphere * cosLatitude,
      -hemisphere * sinLatitude * cosLongitude,
    ),
    radius,
    strength: Math.min(1, Math.max(0, depth / (2 * FRONT_DEPTH_HALF))),
    life,
  };
}

// 枠の極座標(方位 φ・弦 ρ)の単位方向。
function frameDirection(frame: FrontFrame, phi: number, rho: number): THREE.Vector3 {
  return frame.center.clone()
    .addScaledVector(frame.east, rho * Math.cos(phi))
    .addScaledVector(frame.pole, rho * Math.sin(phi))
    .normalize();
}

// 単位方向の緯度・経度 [deg]。経度は畳まない。
function longitudeOf(direction: THREE.Vector3): number {
  return Math.atan2(direction.x, direction.z) * 180 / Math.PI;
}
function latitudeOf(direction: THREE.Vector3): number {
  return Math.asin(Math.max(-1, Math.min(1, direction.y))) * 180 / Math.PI;
}

// 点 direction での +φ 方向(弦を渦向きへ回す向き)を、地図の画素の向き [dx, dy] へ
// 写す。接ベクトルは中心との外積で取り、東・北へ分解して正距円筒の伸び(東へ 1/cosφ)
// 分を割ってから単位化する。
function phiDirectionOnMap(frame: FrontFrame, direction: THREE.Vector3): [number, number] {
  const tangent = new THREE.Vector3().crossVectors(frame.center, direction).normalize();
  return mapDirection(tangent, direction);
}

// 接ベクトル tangent(単位方向 direction の接平面内)の、地図の画素の向き。
function mapDirection(tangent: THREE.Vector3, direction: THREE.Vector3): [number, number] {
  const latitude = latitudeOf(direction) * Math.PI / 180;
  const longitude = longitudeOf(direction) * Math.PI / 180;
  const east = new THREE.Vector3(Math.cos(longitude), 0, -Math.sin(longitude));
  const north = new THREE.Vector3(
    -Math.sin(latitude) * Math.sin(longitude), Math.cos(latitude),
    -Math.sin(latitude) * Math.cos(longitude),
  );
  const e = tangent.dot(east) / Math.cos(latitude);
  const n = tangent.dot(north);
  const length = Math.hypot(e, n) || 1;
  return [e / length, -n / length]; // 地図の y は南(下)が正
}

// 折れ線の 1 点。地図の画素座標と記号を向ける +φ 方向。
interface FrontPoint {
  readonly x: number;
  readonly y: number;
  readonly dirX: number;
  readonly dirY: number;
}

// 腕 1 本。極曲線 φ(ρ) = bearing + curve·rN を ARM_START..ARM_END まで切る。
// 経度は連続に解いて折れ線が日付変更線で飛ばないようにする。
function armPoints(frame: FrontFrame, bearing: number, curve: number, lengthR: number,
  view: MapView): FrontPoint[] {
  const points: FrontPoint[] = [];
  let previousLon = 0;
  for (let i = 0; i <= ARM_POINTS; i += 1) {
    const rN = ARM_START + (ARM_END * lengthR - ARM_START) * (i / ARM_POINTS);
    const phi = bearing + curve * rN;
    const direction = frameDirection(frame, phi, (rN * frame.radius) / R_EARTH);
    const raw = longitudeOf(direction);
    // 前の点へ最も近い繰り返しへ畳む — 小刻みなので差は必ず ±180° 以内。
    const lon = i === 0 ? raw : previousLon + (((raw - previousLon + 540) % 360) - 180);
    previousLon = lon;
    const [dirX, dirY] = phiDirectionOnMap(frame, direction);
    points.push({ x: view.lonToX(lon), y: view.latToY(latitudeOf(direction)), dirX, dirY });
  }
  return points;
}

// 巻きの弧。方位 WRAP_BEARING ± 幅で、半径は (ずれ·螺旋 + 1)·WRAP_RADIUS·半径。
function wrapPoints(frame: FrontFrame, view: MapView): FrontPoint[] {
  const points: FrontPoint[] = [];
  let previousLon = 0;
  for (let i = 0; i <= WRAP_ARC_POINTS; i += 1) {
    const d = -WRAP_ARC_SPAN + 2 * WRAP_ARC_SPAN * (i / WRAP_ARC_POINTS);
    const phi = WRAP_BEARING + d * WRAP_SPAN;
    const clamped = Math.max(-1, Math.min(1, d));
    const rN = (clamped * WRAP_SPIRAL + 1) * WRAP_RADIUS;
    const direction = frameDirection(frame, phi, (rN * frame.radius) / R_EARTH);
    const raw = longitudeOf(direction);
    const lon = i === 0 ? raw : previousLon + (((raw - previousLon + 540) % 360) - 180);
    previousLon = lon;
    const [dirX, dirY] = phiDirectionOnMap(frame, direction);
    points.push({ x: view.lonToX(lon), y: view.latToY(latitudeOf(direction)), dirX, dirY });
  }
  return points;
}

function pathOf(points: readonly FrontPoint[]): Path2D {
  const path = new Path2D();
  points.forEach((point, index) => {
    if (index === 0) path.moveTo(point.x, point.y);
    else path.lineTo(point.x, point.y);
  });
  return path;
}

// 寒冷前線の三角 — 頂点を +φ 方向(暖域へ向かう向き)へ向けて線に乗せる。
function coldTriangles(points: readonly FrontPoint[]): Path2D {
  const path = new Path2D();
  for (let i = 2; i < points.length - 2; i += SYMBOL_EVERY) {
    const { x, y, dirX, dirY } = points[i]!;
    const px = -dirY;
    const py = dirX;
    path.moveTo(x + dirX * TRIANGLE_SIZE * 1.1, y + dirY * TRIANGLE_SIZE * 1.1);
    path.lineTo(x - dirX * TRIANGLE_SIZE * 0.6 + px * TRIANGLE_SIZE * 0.8,
      y - dirY * TRIANGLE_SIZE * 0.6 + py * TRIANGLE_SIZE * 0.8);
    path.lineTo(x - dirX * TRIANGLE_SIZE * 0.6 - px * TRIANGLE_SIZE * 0.8,
      y - dirY * TRIANGLE_SIZE * 0.6 - py * TRIANGLE_SIZE * 0.8);
    path.closePath();
  }
  return path;
}

// 温暖前線の半円 — +φ 側へ膨らむ半円を線に乗せる。
function warmSemicircles(points: readonly FrontPoint[]): Path2D {
  const path = new Path2D();
  for (let i = 2; i < points.length - 2; i += SYMBOL_EVERY) {
    const { x, y, dirX, dirY } = points[i]!;
    const angle = Math.atan2(dirY, dirX);
    path.arc(x, y, SEMICIRCLE_SIZE, angle - Math.PI / 2, angle + Math.PI / 2);
    path.closePath();
  }
  return path;
}

// 巻きの弧の記号 — 三角と半円を交互に、+φ 方向へ向けて置く。
function occludedSymbols(points: readonly FrontPoint[]): Path2D {
  const path = new Path2D();
  let flip = false;
  for (let i = 2; i < points.length - 2; i += SYMBOL_EVERY) {
    const { x, y, dirX, dirY } = points[i]!;
    flip = !flip;
    if (flip) {
      const px = -dirY;
      const py = dirX;
      path.moveTo(x + dirX * TRIANGLE_SIZE * 1.0, y + dirY * TRIANGLE_SIZE * 1.0);
      path.lineTo(x - dirX * TRIANGLE_SIZE * 0.6 + px * TRIANGLE_SIZE * 0.75,
        y - dirY * TRIANGLE_SIZE * 0.6 + py * TRIANGLE_SIZE * 0.75);
      path.lineTo(x - dirX * TRIANGLE_SIZE * 0.6 - px * TRIANGLE_SIZE * 0.75,
        y - dirY * TRIANGLE_SIZE * 0.6 - py * TRIANGLE_SIZE * 0.75);
      path.closePath();
    } else {
      const angle = Math.atan2(dirY, dirX);
      path.arc(x, y, SEMICIRCLE_SIZE, angle - Math.PI / 2, angle + Math.PI / 2);
      path.closePath();
    }
  }
  return path;
}

// 前線 1 組(腕と記号)を塗る。色は RGB 3 連、濃さは前線の強さ。
function strokeFront(context: CanvasRenderingContext2D, points: readonly FrontPoint[],
  symbols: Path2D, color: string, strength: number, view: MapView): void {
  strokeWrapped(context, view, () => {
    context.strokeStyle = `rgba(${color}, ${0.55 + 0.45 * strength})`;
    context.lineWidth = 3;
    context.stroke(pathOf(points));
    context.fillStyle = `rgba(${color}, ${0.6 + 0.4 * strength})`;
    context.fill(symbols);
  });
}

// 温帯低気圧 1 つの前線。巻き → 寒冷 → 温暖の順に、手前が奥を隠す順で重ねる。
function drawFronts(context: CanvasRenderingContext2D, placement: CyclonePlacement, view: MapView): void {
  const frame = frontFrameOf(placement);
  const wrapStrength = THREE.MathUtils.smoothstep(placement.life, WRAP_ONSET, WRAP_FULL);
  if (wrapStrength > 0.12) {
    const wrap = wrapPoints(frame, view);
    strokeFront(context, wrap, occludedSymbols(wrap), WRAP_COLOR,
      frame.strength * wrapStrength, view);
  }
  const cold = armPoints(frame, COLD_BEARING, COLD_CURVE, COLD_LENGTH, view);
  strokeFront(context, cold, coldTriangles(cold), COLD_COLOR, frame.strength, view);
  // 温暖前線の向きは成熟へ向けて渦向き側へ回る — モデルと同じ回し方。
  const warmBearing = WARM_BEARING
    - THREE.MathUtils.smoothstep(placement.life, 0.15, 0.75) * WARM_NARROW;
  const warm = armPoints(frame, warmBearing, 0, WARM_LENGTH, view);
  strokeFront(context, warm, warmSemicircles(warm), WARM_COLOR, frame.strength, view);
}

// 中心の記号。L / H と気圧値、眼を持つなら眼の印。
function drawCenterLabel(
  context: CanvasRenderingContext2D, fields: SynopticFields,
  placement: CyclonePlacement, letter: 'L' | 'H', eyeStrength: number, view: MapView,
): void {
  const x = view.lonToX(placement.longitude * 180 / Math.PI);
  const y = view.latToY(placement.latitude * 180 / Math.PI);
  // 中心の気圧は面から拾う — 低気圧は落ち込み、高気圧は盛り上がり。
  const pressure = Math.round(1013 + sampleField(
    fields.pressure, fields.width, fields.height,
    placement.longitude, placement.latitude));
  strokeWrapped(context, view, () => {
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.font = '700 26px "JetBrains Mono", ui-monospace, monospace';
    context.lineWidth = 4;
    context.strokeStyle = 'rgba(10, 13, 17, 0.85)';
    context.fillStyle = letter === 'L' ? 'rgba(255, 120, 100, 0.95)' : 'rgba(110, 170, 255, 0.95)';
    context.strokeText(letter, x, y);
    context.fillText(letter, x, y);
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

// 低・高気圧の記号をまとめて置く。seconds は現在時刻 [s]、view は地図の見せる窓。
export function drawCycloneSymbols(
  context: CanvasRenderingContext2D, fields: SynopticFields, seconds: number, view: MapView,
): void {
  // 温帯低気圧 — 前線と L。
  for (let index = 0; index < LOW_COUNT; index += 1) {
    const placement = lowPlacementAt(index, seconds, R_EARTH);
    if (placement === null || placement.depth < 2) continue;
    drawFronts(context, placement, view);
    drawCenterLabel(context, fields, placement, 'L', 0, view);
  }
  // 熱帯低気圧 — 前線は持たず、L と眼だけ。
  const tropical = tropicalPlacementAt(seconds);
  if (tropical !== null && tropical.depth >= 2) {
    const eye = eyeStrengthOf(
      tropical.depth, tropical.radius, tropical.latitude, R_EARTH, SIDEREAL_DAY);
    drawCenterLabel(context, fields, tropical, 'L', eye, view);
  }
  // 高気圧 — H だけ。
  for (let index = 0; index < HIGH_COUNT; index += 1) {
    const placement = highPlacementAt(index, seconds, R_EARTH);
    if (placement === null || placement.depth < 2) continue;
    drawCenterLabel(context, fields, placement, 'H', 0, view);
  }
}
