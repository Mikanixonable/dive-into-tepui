// 近傍拡散補正の走査の補助関数を、スライスの半球の余弦重みの測度と、扇形の丸めの理論値で検査する。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { float, int, uint, uniform, vec2, vec3 } from 'three/tsl';
import {
  angleOf, capRange, maskedMeasure, sectorPosition, segmentEnd, segmentSectors, sliceAt, wedgeWeight,
} from '../../src/render/pipeline/screen-space/hemisphere-scan';
import { test } from '../harness';
import { evaluateShaderNode } from './tsl-node-evaluator';
import type { FloatNode, Vec3Node } from '../../src/render/tsl-types';

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
  return capRange(sliceWithNormalAngle(CAP_NORMAL_ANGLE), vectorNode(VIEW), {
    direction: vectorNode(inSlice(cap.center, cap.tilt)), cosAngle: float(Math.cos(cap.halfWidth)),
  }, dither);
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
              valueOf(wedgeWeight(slice, vectorNode(view), vectorNode(direction), int(sliceCount))))
              .reduce((total, weight) => total + weight, 0);
            near(sum, 1, 1e-9, `slices=${sliceCount} rotation=${rotation} azimuth=${azimuth}`);
          }
        }
      }
    }
  });

  test('screen space estimator: 受け手と同じ平面の標本の切片は、その平面に留まり測度を持たない', () => {
    // 正方形の画角の透視投影(WebGPU の座標系、逆深度)。uv の等方な歩みが view 空間でも等方になる。
    const projection = new THREE.Matrix4()
      .makePerspective(-0.05, 0.05, 0.05, -0.05, 0.1, 100, THREE.WebGPUCoordinateSystem, true);
    const projectionInverse = uniform(projection.clone().invert());
    const normal = new THREE.Vector3(0.2, 1, 0.3).normalize();
    const receiver = new THREE.Vector3(0.3, -1, -4);
    const view = receiver.clone().normalize().negate();
    const ndc = receiver.clone().applyMatrix4(projection);
    const receiverUv = new THREE.Vector2(ndc.x / 2 + 0.5, 0.5 - ndc.y / 2);
    // uv を通る視線と受け手の接平面の交点。視線はカメラの原点を通る。
    const onPlane = (uv: THREE.Vector2): THREE.Vector3 => {
      const ray = new THREE.Vector3(uv.x * 2 - 1, 1 - uv.y * 2, 0.5).applyMatrix4(projectionInverse.value).normalize();
      return ray.multiplyScalar(normal.dot(receiver) / normal.dot(ray));
    };
    for (const angle of [0.3, 1.9, 4.2]) {
      const slice = sliceAt(float(angle), vectorNode(view), vectorNode(normal));
      const step = new THREE.Vector2(Math.cos(angle), -Math.sin(angle));
      const sample = onPlane(receiverUv.clone().addScaledVector(step, 0.02));
      // 視線と接平面の交点が球の内側にあるもの・外側にあるものと、視線が接平面と前で交わらないものを含む。
      const toEnds = [0.003, 0.03, 0.4, 0.8].map((distance) => {
        const uv = receiverUv.clone().addScaledVector(step, distance);
        return segmentEnd(vec2(uv.x, uv.y), projectionInverse, vectorNode(sample), vectorNode(normal),
          vectorNode(receiver)).sub(vectorNode(receiver));
      });
      for (const toEnd of toEnds) {
        const offset = new THREE.Vector3().fromArray(evaluateShaderNode(toEnd) as number[]);
        near(offset.dot(normal), 0, 1e-9, `angle=${angle} 端`);
      }
      const angles = [...toEnds, vectorNode(sample.clone().sub(receiver))]
        .map((toPoint) => valueOf(angleOf(slice, vectorNode(view), toPoint)));
      const lower = Math.min(...angles);
      const upper = Math.max(...angles);
      for (const dither of ditherGrid(16)) {
        const lowerPosition = sectorPosition(slice, float(lower), float(dither));
        const upperPosition = sectorPosition(slice, float(upper), float(dither));
        near(valueOf(upperPosition) - valueOf(lowerPosition), 0, 1e-9, `angle=${angle} 測度`);
        assert.equal(valueOf(segmentSectors(lowerPosition, upperPosition)), 0, `angle=${angle} dither=${dither}`);
      }
    }
  });
}
