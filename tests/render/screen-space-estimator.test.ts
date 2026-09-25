// 近傍拡散補正の走査の補助関数を、スライスの半球の余弦重みの測度、扇形の丸め、視線と平面の幾何の理論値で検査する。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { bool, float, int, uint, uniform, vec2, vec3 } from 'three/tsl';
import { clipToCircle, projectedRadius } from '../../src/render/pipeline/screen-space/hemisphere-scan';
import {
  angleOf, capRange, maskedMeasure, sectorPosition, segmentSectors, sliceAt, toSliceCoordinates, wedgeWeight,
} from '../../src/render/pipeline/screen-space/slice-sectors';
import {
  rayAt, sideRays, splitSegments, type SideRays, type SlicePoint,
} from '../../src/render/pipeline/screen-space/tangent-segments';
import { viewRayAt } from '../../src/render/pipeline/view-ray';
import { test } from '../harness';
import { evaluateShaderNode } from './tsl-node-evaluator';
import type { FloatNode, Vec2Node, Vec3Node } from '../../src/render/tsl-types';

// スライス 1 枚を刻む扇形の数。
const SECTOR_COUNT = 32;
const HALF_PI = Math.PI / 2;
// 受け手の視線(view 空間の単位ベクトル)と、スライスの画面上の角 [rad]。
const VIEW = new THREE.Vector3(0.2, -0.3, 1).normalize();
const SLICE_ANGLE = 0.7;
// 球冠を置くスライスの、射影した法線の角 n [rad]。半球は [n − π/2, n + π/2] ≈ [−1.07, 2.07]。
const CAP_NORMAL_ANGLE = 0.5;
// 球冠の中心の角・半幅 [rad] と、スライス平面の外への傾き [rad]。半球の外・中・地平をまたぐものを並べる。
const CAPS = [
  { center: 2.8, halfWidth: 0.3, tilt: 0.5 },
  { center: -1.8, halfWidth: 0.4, tilt: 0 },
  // 後ろ向き。2π 回すと上の地平の外。
  { center: -2.9, halfWidth: 0.2, tilt: 0.3 },
  { center: 0.9, halfWidth: 0.3, tilt: 0.5 },
  { center: 1.9, halfWidth: 0.4, tilt: 0 },
  { center: -1.0, halfWidth: 0.3, tilt: 0.2 },
  // 後ろ向き。2π 回すと上の地平をまたぐ。
  { center: -3.0, halfWidth: 1.3, tilt: 0 },
] as const;

type Cap = typeof CAPS[number];

// 差が tolerance 以内であることを検査する。
function near(actual: number, expected: number, tolerance: number, label: string): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected}`);
}

// スカラーのノードの値。
function valueOf(node: unknown): number {
  return evaluateShaderNode(node) as number;
}

// 同じ値の vec3 定数ノード。
function vectorNode(vector: THREE.Vector3): Vec3Node {
  return vec3(vector.x, vector.y, vector.z);
}

// 立っているビットの数。
function popcount(bits: number): number {
  return [...bits.toString(2)].filter((bit) => bit === '1').length;
}

// 0..1 を count 等分した区間の中点。一様なずれの代表。
function ditherGrid(count: number): number[] {
  return Array.from({ length: count }, (_, k) => (k + 0.5) / count);
}

// 射影した法線の角が n のスライスで、角 from..to が持つ余弦重みの測度 ∫ cos(h − n)·|sin h| dh の数値積分。
// 誤差は 1e-8 程度。
function cosineMeasure(from: number, to: number, n: number): number {
  // |sin h| の折れる 0 で分ける。
  if (from < 0 && to > 0) return cosineMeasure(from, 0, n) + cosineMeasure(0, to, n);
  const steps = 20000;
  const width = (to - from) / steps;
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    const h = from + (i + 0.5) * width;
    sum += Math.cos(h - n) * Math.abs(Math.sin(h));
  }
  return sum * width;
}

// 半球の下端 n − π/2 から h までの測度を、半球全体の測度に対する割合で 0..SECTOR_COUNT へ写したもの。
function measureCoordinate(h: number, n: number): number {
  return SECTOR_COUNT * cosineMeasure(n - HALF_PI, h, n) / cosineMeasure(n - HALF_PI, n + HALF_PI, n);
}

// 扇形の座標の理論値 — 測度の座標を dither − ½ だけずらしたもの。
function expectedPosition(h: number, n: number, dither: number): number {
  return measureCoordinate(h, n) + dither - 0.5;
}

// VIEW と画面上の向き SLICE_ANGLE が張るスライス平面の中で VIEW から角 h だけ回した単位ベクトルを、平面の外へ
// tilt だけ傾けたもの。平面へ射影した角は h のまま。
function inSlice(h: number, tilt: number): THREE.Vector3 {
  const screen = new THREE.Vector3(Math.cos(SLICE_ANGLE), Math.sin(SLICE_ANGLE), 0);
  const ortho = screen.clone().addScaledVector(VIEW, -screen.dot(VIEW)).normalize();
  const axis = new THREE.Vector3().crossVectors(VIEW, ortho);
  return VIEW.clone().multiplyScalar(Math.cos(h)).addScaledVector(ortho, Math.sin(h))
    .multiplyScalar(Math.cos(tilt)).addScaledVector(axis, Math.sin(tilt));
}

// 射影した法線の角が n のスライス。法線は平面の外へも傾ける。
function sliceWithNormalAngle(n: number): ReturnType<typeof sliceAt> {
  return sliceAt(float(SLICE_ANGLE), vectorNode(VIEW), vectorNode(inSlice(n, 0.4)));
}

// 射影した法線の角が CAP_NORMAL_ANGLE のスライスへ写した、球冠 cap の範囲。
function capRangeOf(cap: Cap, dither: FloatNode): ReturnType<typeof capRange> {
  return capRange(sliceWithNormalAngle(CAP_NORMAL_ANGLE), {
    direction: vectorNode(inSlice(cap.center, cap.tilt)), cosAngle: float(Math.cos(cap.halfWidth)),
  }, dither);
}

// 正方形の画角の透視投影(WebGPU の座標系、逆深度)。uv の等方な歩みが view 空間でも等方になる。
const PERSPECTIVE = new THREE.Matrix4()
  .makePerspective(-0.05, 0.05, 0.05, -0.05, 0.1, 100, THREE.WebGPUCoordinateSystem, true);
// 走査の画面の一辺 [走査の画素]。
const SCREEN_PIXELS = 200;
// 荷室を模した view 空間の平面。床(受け手が載る)、その奥に立つ壁、そのあいだの床に載る箱の前面。
// 箱の前面は、走査の向き BAY_SLICE_ANGLE で画面距離 7〜31 画素に写り、その先 36 画素から奥の壁が写る。
const FLOOR: Plane = { normal: new THREE.Vector3(0.05, 1, 0.1).normalize(), point: new THREE.Vector3(0, -1, -4) };
const WALL: Plane = { normal: new THREE.Vector3(-0.2, 0.1, 1).normalize(), point: new THREE.Vector3(0, -0.5, -6) };
const BOX_FRONT: Plane = { normal: new THREE.Vector3(0.15, 0, 1).normalize(), point: new THREE.Vector3(0, -1, -3.6) };
// 受け手の uv と、スライスの画面上の角 [rad]。
const RECEIVER_UV = new THREE.Vector2(0.53, 0.82);
const BAY_SLICE_ANGLE = 1.45;

// 点 point を通り法線 normal(単位ベクトル)を持つ平面。
interface Plane {
  readonly normal: THREE.Vector3;
  readonly point: THREE.Vector3;
}

// 平面から点までの符号つき距離。
function planeDistance(plane: Plane, point: THREE.Vector3): number {
  return plane.normal.dot(point.clone().sub(plane.point));
}

// 透視投影 PERSPECTIVE で uv を通る視線と平面の交点(view 空間)。
function onPlane(plane: Plane, uv: THREE.Vector2): THREE.Vector3 {
  const inverse = PERSPECTIVE.clone().invert();
  const near = new THREE.Vector3(uv.x * 2 - 1, 1 - uv.y * 2, 1).applyMatrix4(inverse);
  const direction = new THREE.Vector3(uv.x * 2 - 1, 1 - uv.y * 2, 0).applyMatrix4(inverse).sub(near);
  return near.addScaledVector(direction, planeDistance(plane, near) / -plane.normal.dot(direction));
}

// view 空間の点を透視投影 PERSPECTIVE で写した uv。
function uvOf(point: THREE.Vector3): THREE.Vector2 {
  const ndc = point.clone().applyMatrix4(PERSPECTIVE);
  return new THREE.Vector2(ndc.x / 2 + 0.5, 0.5 - ndc.y / 2);
}

// 3 つの平面の交点。
function intersection(a: Plane, b: Plane, c: Plane): THREE.Vector3 {
  const normals = new THREE.Matrix3().set(
    a.normal.x, a.normal.y, a.normal.z, b.normal.x, b.normal.y, b.normal.z, c.normal.x, c.normal.y, c.normal.z);
  const offsets = new THREE.Vector3(a.normal.dot(a.point), b.normal.dot(b.point), c.normal.dot(c.point));
  return offsets.applyMatrix3(normals.invert());
}

// 荷室を、受け手 RECEIVER_UV から画面上の角 BAY_SLICE_ANGLE の向きへ走査するところ。
interface BayScan {
  // 受け手の uv の歩み [uv/走査の画素]。
  readonly uvStep: THREE.Vector2;
  // 受け手(床の点、view 空間)。
  readonly receiver: THREE.Vector3;
  // スライス平面(カメラと受け手の視線と歩みの向きを含む)と、そのスライスと走査の側の視線。
  readonly slicePlane: Plane;
  readonly slice: ReturnType<typeof sliceAt>;
  readonly rays: SideRays;
}

// 荷室の走査を組む。**テストの中から呼ぶこと** — スライスと視線はノードとして組む。
function bayScan(): BayScan {
  const uvStep = new THREE.Vector2(Math.cos(BAY_SLICE_ANGLE), -Math.sin(BAY_SLICE_ANGLE)).divideScalar(SCREEN_PIXELS);
  // スライス平面は、カメラ・受け手・1 画素先の床の点を通る。
  const receiver = onPlane(FLOOR, RECEIVER_UV);
  const next = onPlane(FLOOR, RECEIVER_UV.clone().add(uvStep));
  const slice = sliceAt(float(BAY_SLICE_ANGLE), vectorNode(receiver.clone().normalize().negate()),
    vectorNode(FLOOR.normal));
  return {
    uvStep,
    receiver,
    slicePlane: { normal: new THREE.Vector3().crossVectors(receiver, next).normalize(), point: new THREE.Vector3() },
    slice,
    rays: sideRays(slice, vectorNode(receiver), vec2(RECEIVER_UV.x, RECEIVER_UV.y), vec2(uvStep.x, uvStep.y),
      uniform(PERSPECTIVE.clone().invert())),
  };
}

// 画面距離 rho の視線が平面 plane と交わる点を、平面の中でスライス平面の外へ drift [m] ずらした点を、その平面の
// 標本とする(スライスの座標)。
function sampleAt(plane: Plane, { uvStep, receiver, slice, slicePlane }: BayScan, rho: number, drift = 0): SlicePoint {
  const across = slicePlane.normal.clone().projectOnPlane(plane.normal).normalize();
  const toSample = onPlane(plane, RECEIVER_UV.clone().addScaledVector(uvStep, rho)).sub(receiver)
    .addScaledVector(across, drift);
  return {
    position: toSliceCoordinates(slice, vectorNode(toSample)),
    normal: toSliceCoordinates(slice, vectorNode(plane.normal)),
    offset: float(plane.normal.dot(toSample)),
  };
}

// 受け手自身を面の点としたもの(スライスの座標)。
function receiverPoint({ slice }: BayScan): SlicePoint {
  return { position: vec2(0, 0), normal: toSliceCoordinates(slice, vectorNode(FLOOR.normal)), offset: float(0) };
}

// スライスの座標の点 point を view 空間へ戻したもの。
function lifted({ receiver, slice }: BayScan, point: Vec2Node): THREE.Vector3 {
  const [x, y] = evaluateShaderNode(point) as number[];
  return receiver.clone().addScaledVector(vectorOf(slice.view), x!).addScaledVector(vectorOf(slice.orthoDirection), y!);
}

// ベクトルのノードの値。
function vectorOf(node: Vec3Node): THREE.Vector3 {
  return new THREE.Vector3().fromArray(evaluateShaderNode(node) as number[]);
}

// 点 point が、受け手から画面距離 rho の視線に乗っていることを検査する。
function assertOnRay(point: THREE.Vector3, { uvStep }: BayScan, rho: number, label: string): void {
  const offset = uvOf(point).sub(RECEIVER_UV);
  near(offset.length() * SCREEN_PIXELS, rho, 1e-9, `${label} 画面距離`);
  near(offset.x * uvStep.y - offset.y * uvStep.x, 0, 1e-12, `${label} 向き`);
}

// 面の点 sample から端 end へ向かう線分を受け手の円で切った先の点を、受け手から見た扇形の座標。
function endPosition({ slice }: BayScan, sample: SlicePoint, end: Vec2Node, dither: number): number {
  return valueOf(sectorPosition(slice, angleOf(slice, clipToCircle(sample.position, end)), float(dither)));
}

// 球冠の角の区間を半球 [n − π/2, n + π/2] で切ったもの。2π の周期のうち半球と重なるものを取り、どれも
// 重ならなければ null。
function clippedCap(cap: Cap, n: number): readonly [number, number] | null {
  for (const turn of [-1, 0, 1]) {
    const center = cap.center + turn * 2 * Math.PI;
    const lower = Math.max(center - cap.halfWidth, n - HALF_PI);
    const upper = Math.min(center + cap.halfWidth, n + HALF_PI);
    if (lower < upper) return [lower, upper];
  }
  return null;
}

// この層の回帰テストを登録する。
export function register(): void {
  test('screen space estimator: 扇形の座標は角について単調で、半球の両端を dither − ½ と 32 + dither − ½ へ写す', () => {
    for (const n of [-1.2, 0, 0.5, 1.45]) {
      const slice = sliceWithNormalAngle(n);
      const angles = Array.from({ length: 61 }, (_, k) => n - HALF_PI + Math.PI * k / 60);
      const coordinates = angles.map((h) => measureCoordinate(h, n));
      for (const dither of [0.13, 0.71]) {
        const positions = angles.map((h) => valueOf(sectorPosition(slice, float(h), float(dither))));
        near(positions[0]!, dither - 0.5, 1e-9, `n=${n} 下端`);
        near(positions[60]!, SECTOR_COUNT + dither - 0.5, 1e-9, `n=${n} 上端`);
        angles.forEach((h, k) => near(positions[k]!, coordinates[k]! + dither - 0.5, 1e-5, `n=${n} h=${h}`));
        positions.slice(1).forEach((position, k) => assert.ok(position > positions[k]!, `n=${n} k=${k + 1}`));
      }
    }
  });

  test('screen space estimator: 球冠の範囲は半球で切った区間の余弦重み測度で、半球の外なら幅 0', () => {
    for (const dither of [0.13, 0.71]) {
      for (const cap of CAPS) {
        const range = capRangeOf(cap, float(dither));
        const lower = valueOf(range.lower);
        const upper = valueOf(range.upper);
        const clipped = clippedCap(cap, CAP_NORMAL_ANGLE);
        const label = `center=${cap.center} dither=${dither}`;
        if (clipped === null) {
          near(upper - lower, 0, 1e-9, label);
        } else {
          near(lower, expectedPosition(clipped[0], CAP_NORMAL_ANGLE, dither), 1e-5, `${label} 下端`);
          near(upper, expectedPosition(clipped[1], CAP_NORMAL_ANGLE, dither), 1e-5, `${label} 上端`);
        }
      }
    }
  });

  test('screen space estimator: 同じずれで丸めた隣の切片は継ぎ目なく並び、立つビット数の期待値は区間の測度', () => {
    const n = CAP_NORMAL_ANGLE;
    const slice = sliceWithNormalAngle(n);
    const dither = uniform(0);
    const position = (h: number): FloatNode => sectorPosition(slice, float(h), dither);
    const triples = [[n - HALF_PI, 0.1, n + HALF_PI], [-0.6, 0.35, 1.3], [0.2, 0.25, 0.9]] as const;
    const grid = ditherGrid(1000);
    for (const [a, b, c] of triples) {
      const first = segmentSectors(position(a), position(b));
      const second = segmentSectors(position(b), position(c));
      const whole = segmentSectors(position(a), position(c));
      let count = 0;
      for (const value of grid) {
        dither.value = value;
        const firstBits = valueOf(first);
        const secondBits = valueOf(second);
        assert.equal((firstBits & secondBits) >>> 0, 0, `a=${a} b=${b} dither=${value}`);
        assert.equal((firstBits | secondBits) >>> 0, valueOf(whole), `a=${a} b=${b} c=${c} dither=${value}`);
        count += popcount(firstBits);
      }
      // 格子の平均と一様分布の期待値の差は、端 1 つにつき 1 / grid.length 以内。
      near(count / grid.length, measureCoordinate(b, n) - measureCoordinate(a, n), 2 / grid.length, `a=${a} b=${b}`);
    }
  });

  test('screen space estimator: 全ビットの測度は範囲の幅、ビットなしは 0', () => {
    for (const [lower, upper] of [[-0.3, 12.6], [5.2, 5.7], [30.9, 32.4], [0.4, 31.2]] as const) {
      const range = { lower: float(lower), upper: float(upper) };
      near(valueOf(maskedMeasure(uint(0xffffffff), range)), upper - lower, 1e-12, `${lower}..${upper}`);
      assert.equal(valueOf(maskedMeasure(uint(0), range)), 0);
    }
  });

  test('screen space estimator: 球冠の触れる扇形をすべて立てた切片は、同じずれの下で球冠の幅だけ塞ぐ', () => {
    const slice = sliceWithNormalAngle(CAP_NORMAL_ANGLE);
    // 扇形の座標 position を含む扇形の番号。両端の扇形は半球の縁までを受け持つ。
    const sectorOf = (position: number): number => Math.min(Math.max(Math.floor(position), 0), SECTOR_COUNT - 1);
    for (const cap of CAPS) {
      const clipped = clippedCap(cap, CAP_NORMAL_ANGLE);
      if (clipped === null) continue;
      for (const dither of ditherGrid(64)) {
        const range = capRangeOf(cap, float(dither));
        // 球冠の両端を同じずれで扇形の座標へ写し、外側の扇形の境まで広げた切片。同じ区間の切片では、中心が区間の
        // 外にある端の扇形が立たず、その分だけ幅に届かない。
        const first = sectorOf(valueOf(sectorPosition(slice, float(clipped[0]), float(dither))));
        const last = sectorOf(valueOf(sectorPosition(slice, float(clipped[1]), float(dither))));
        const blocked = valueOf(maskedMeasure(segmentSectors(float(first), float(last + 1)), range));
        near(blocked, valueOf(range.upper) - valueOf(range.lower), 1e-9, `center=${cap.center} dither=${dither}`);
      }
    }
  });

  test('screen space estimator: 等間隔のスライスの楔の重みは、どの方位でも和が 1', () => {
    // 視線が画面に垂直なら、画面上で等間隔のスライスは視線のまわりでも等間隔。
    const view = new THREE.Vector3(0, 0, 1);
    const azimuths = Array.from({ length: 24 }, (_, k) => (k + 0.1) * 2 * Math.PI / 24);
    for (const sliceCount of [2, 3, 5]) {
      for (const rotation of [0, 0.37]) {
        const slices = Array.from({ length: sliceCount }, (_, i) =>
          sliceAt(float((i + rotation) * Math.PI / sliceCount), vectorNode(view), vectorNode(view)));
        for (const elevation of [0.3, 1.2, 2.6]) {
          for (const azimuth of azimuths) {
            const direction = new THREE.Vector3(Math.sin(elevation) * Math.cos(azimuth),
              Math.sin(elevation) * Math.sin(azimuth), Math.cos(elevation));
            const sum = slices.map((slice) =>
              valueOf(wedgeWeight(slice, vectorNode(direction), int(sliceCount))))
              .reduce((total, weight) => total + weight, 0);
            near(sum, 1, 1e-9, `slices=${sliceCount} rotation=${rotation} azimuth=${azimuth}`);
          }
        }
      }
    }
  });

  test('screen space estimator: スライスの片側の視線は、透視でも平行投影でも画面距離の一次式で表せる', () => {
    // どれも uv の等方な歩みが view 空間でも等方になる(視線がスライス平面に載る)投影。
    const projections = {
      '透視': PERSPECTIVE,
      '中心のずれた透視': new THREE.Matrix4()
        .makePerspective(-0.03, 0.07, 0.06, -0.04, 0.1, 100, THREE.WebGPUCoordinateSystem, true),
      '平行投影': new THREE.Matrix4()
        .makeOrthographic(-2, 3, 4, -1, 0.1, 100, THREE.WebGPUCoordinateSystem, true),
    };
    const uv = new THREE.Vector2(0.37, 0.61);
    const angle = 2.6;
    const uvStep = new THREE.Vector2(Math.cos(angle), -Math.sin(angle)).divideScalar(SCREEN_PIXELS);
    const normal = new THREE.Vector3(0.3, 0.8, 0.5).normalize();
    for (const [label, projection] of Object.entries(projections)) {
      const projectionInverse = uniform(projection.clone().invert());
      const receiverRay = viewRayAt(projectionInverse, vec2(uv.x, uv.y));
      const receiver = vectorOf(receiverRay.origin).addScaledVector(vectorOf(receiverRay.direction), 5);
      const slice = sliceAt(float(angle), receiverRay.direction.negate(), vectorNode(normal));
      const rays = sideRays(slice, vectorNode(receiver), vec2(uv.x, uv.y), vec2(uvStep.x, uvStep.y), projectionInverse);
      for (const rho of [0, 1, 7.5, 60, 240]) {
        const target = uv.clone().addScaledVector(uvStep, rho);
        const expected = viewRayAt(projectionInverse, vec2(target.x, target.y));
        const toOrigin = vectorOf(expected.origin).sub(receiver);
        near(toOrigin.dot(vectorOf(slice.axis)), 0, 1e-9, `${label} rho=${rho} スライス平面の上`);
        const ray = rayAt(rays, float(rho));
        const origin = evaluateShaderNode(ray.origin) as number[];
        const expectedOrigin = evaluateShaderNode(toSliceCoordinates(slice, vectorNode(toOrigin))) as number[];
        near(Math.hypot(origin[0]! - expectedOrigin[0]!, origin[1]! - expectedOrigin[1]!), 0, 1e-9,
          `${label} rho=${rho} 起点`);
        const direction = new THREE.Vector2().fromArray(evaluateShaderNode(ray.direction) as number[]).normalize();
        const expectedDirection = new THREE.Vector2()
          .fromArray(evaluateShaderNode(toSliceCoordinates(slice, expected.direction)) as number[]);
        near(direction.distanceTo(expectedDirection), 0, 1e-9, `${label} rho=${rho} 向き`);
      }
    }
  });

  test('screen space estimator: 床の受け手と奥に立つ壁の標本は凹の継ぎ目で継がれ、壁の切片は床の地平から始まる', () => {
    const bay = bayScan();
    const expected = intersection(FLOOR, WALL, bay.slicePlane);
    for (const rho of [40, 55, 90]) {
      const wall = sampleAt(WALL, bay, rho);
      const split = splitSegments(bay.rays, receiverPoint(bay), float(0), wall, float(rho), bool(true));
      near(lifted(bay, split.farLower).distanceTo(expected), 0, 1e-9, `rho=${rho} 継ぎ目`);
      near(lifted(bay, split.nearUpper).distanceTo(expected), 0, 1e-9, `rho=${rho} 受け手の端`);
      for (const dither of [0.13, 0.71]) {
        // 床の平面の上の向きは、受け手の半球の縁にある。壁の標本自身は縁より上。
        const lower = endPosition(bay, wall, split.farLower, dither);
        const horizon = Math.min(Math.abs(lower - (dither - 0.5)), Math.abs(lower - (SECTOR_COUNT + dither - 0.5)));
        near(horizon, 0, 1e-6, `rho=${rho} dither=${dither} 下端`);
        const own = endPosition(bay, wall, wall.position, dither);
        assert.ok(Math.abs(own - lower) > 1e-3, `rho=${rho} dither=${dither} 標本 ${own}`);
      }
    }
  });

  test('screen space estimator: 同じ平面の隣り合う標本の切片は、中点の視線の上で隙間なく継がれる', () => {
    const bay = bayScan();
    for (const [nearRho, farRho] of [[40, 55], [55, 90], [37, 38]] as const) {
      const first = sampleAt(WALL, bay, nearRho);
      const second = sampleAt(WALL, bay, farRho);
      const split = splitSegments(bay.rays, first, float(nearRho), second, float(farRho), bool(true));
      const upper = lifted(bay, split.nearUpper);
      const label = `${nearRho}..${farRho}`;
      near(upper.distanceTo(lifted(bay, split.farLower)), 0, 1e-9, `${label} 継ぎ目`);
      near(planeDistance(WALL, upper), 0, 1e-9, `${label} 壁の上`);
      assertOnRay(upper, bay, (nearRho + farRho) / 2, label);
      near(endPosition(bay, first, split.nearUpper, 0.4), endPosition(bay, second, split.farLower, 0.4), 1e-9,
        `${label} 角`);
    }
  });

  test('screen space estimator: スライス平面の外へずれた同じ平面の標本どうしも、平面がスライスを切る直線の上で継がれる', () => {
    const bay = bayScan();
    for (const [nearRho, farRho, nearDrift, farDrift] of [[40, 55, 0.02, -0.03], [37, 38, -0.01, 0.01]] as const) {
      const split = splitSegments(bay.rays, sampleAt(WALL, bay, nearRho, nearDrift), float(nearRho),
        sampleAt(WALL, bay, farRho, farDrift), float(farRho), bool(true));
      const upper = lifted(bay, split.nearUpper);
      const label = `${nearRho}..${farRho}`;
      near(upper.distanceTo(lifted(bay, split.farLower)), 0, 1e-9, `${label} 継ぎ目`);
      near(planeDistance(WALL, upper), 0, 1e-9, `${label} 壁の上`);
      assertOnRay(upper, bay, (nearRho + farRho) / 2, label);
    }
  });

  test('screen space estimator: 手前の物体の標本と奥の壁の標本は、中点の視線でそれぞれの平面の上に分かれる', () => {
    const bay = bayScan();
    for (const [nearRho, farRho] of [[20, 40], [28, 60]] as const) {
      const split = splitSegments(bay.rays, sampleAt(BOX_FRONT, bay, nearRho), float(nearRho),
        sampleAt(WALL, bay, farRho), float(farRho), bool(true));
      const label = `${nearRho}..${farRho}`;
      const middle = (nearRho + farRho) / 2;
      const upper = lifted(bay, split.nearUpper);
      const lower = lifted(bay, split.farLower);
      near(planeDistance(BOX_FRONT, upper), 0, 1e-9, `${label} 箱の上端`);
      near(planeDistance(WALL, lower), 0, 1e-9, `${label} 壁の下端`);
      assertOnRay(upper, bay, middle, `${label} 箱の上端`);
      assertOnRay(lower, bay, middle, `${label} 壁の下端`);
      assert.ok(lower.length() > upper.length() + 1, `${label} 壁は箱の奥`);
    }
  });

  test('screen space estimator: 半径の投影は渡した寸法の画素で測り、透視では奥行きに反比例し、平行投影では一定', () => {
    const projections = {
      '中心のずれた透視': new THREE.Matrix4()
        .makePerspective(-0.03, 0.07, 0.06, -0.04, 0.1, 100, THREE.WebGPUCoordinateSystem, true),
      '平行投影': new THREE.Matrix4()
        .makeOrthographic(-2, 3, 4, -1, 0.1, 100, THREE.WebGPUCoordinateSystem, true),
    };
    const full = new THREE.Vector2(960, 540);
    const half = full.clone().multiplyScalar(0.5);
    // view 空間の点 point の半径を、寸法 size の画面の画素で測ったもの。
    const radiusOf = (projection: THREE.Matrix4, point: THREE.Vector3, size: THREE.Vector2): number =>
      valueOf(projectedRadius(vectorNode(point), uniform(projection), vec2(size.x, size.y)));
    // 比べる点は、どれも半径が画面の対角より小さく写る奥行きに置く。
    const reference = new THREE.Vector3(0.3, -0.2, -50);
    for (const [label, projection] of Object.entries(projections)) {
      const perspective = projection.elements[11] !== 0;
      const expected = radiusOf(projection, reference, full);
      near(radiusOf(projection, reference, half), expected / 2, 1e-9 * expected, `${label} 半分の寸法`);
      for (const point of [new THREE.Vector3(-1.5, 0.8, -50), new THREE.Vector3(0.3, -0.2, -80)]) {
        const depthRatio = perspective ? reference.z / point.z : 1;
        near(radiusOf(projection, point, full), expected * depthRatio, 1e-6 * expected, `${label} ${point.toArray()}`);
      }
    }
    // 画面の対角で頭打ちにする。
    const close = radiusOf(projections['中心のずれた透視'], new THREE.Vector3(0, 0, -0.2), half);
    near(close, half.length(), 1e-9, '対角');
  });

  test('screen space estimator: 受け手と同じ平面の標本の切片は、その平面に留まり測度を持たない', () => {
    const bay = bayScan();
    const sampleRho = 4;
    const sample = sampleAt(FLOOR, bay, sampleRho);
    const lower = splitSegments(bay.rays, receiverPoint(bay), float(0), sample, float(sampleRho), bool(true)).farLower;
    // 上端の視線が床と円の内側で交わるもの・外側で交わるものと、床と前で交わらない(地平の上を向く)もの。
    const uppers = [6, 20, 60, 100].map((middle) => splitSegments(bay.rays, sample, float(sampleRho), sample,
      float(2 * middle - sampleRho), bool(false)).nearUpper);
    for (const end of [lower, ...uppers]) {
      near(planeDistance(FLOOR, lifted(bay, clipToCircle(sample.position, end))), 0, 1e-9, '端');
    }
    for (const dither of ditherGrid(16)) {
      const positions = [lower, ...uppers, sample.position].map((end) => endPosition(bay, sample, end, dither));
      const lowerPosition = float(Math.min(...positions));
      const upperPosition = float(Math.max(...positions));
      near(valueOf(upperPosition) - valueOf(lowerPosition), 0, 1e-9, `dither=${dither} 測度`);
      assert.equal(valueOf(segmentSectors(lowerPosition, upperPosition)), 0, `dither=${dither}`);
    }
  });
}
