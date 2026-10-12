// 世界に静止した場面の、参照の再投影。いまのフレームの画素が写す表面の点を、深度から位置を戻して前のフレームのカメラで写し、
// 前のフレームの画素の座標を求める。描画の動きベクトルに頼らない、フレームの間の同じ表面の点の対応づけで、それを使って
// フレームの間の値の差とその大きさの要約を求める。
import * as THREE from 'three/webgpu';
import type { FloatImage } from './lab';

// 写した点の素の深度と、前のフレームの 2×2 の近傍の素の深度を双線形に読んだ値とが、この比より離れたら同じ面とみなさない。
// 平面の素の深度は画面の上で一次なので、平面の上では丸めの分しか離れない。
const SAME_SURFACE_TOLERANCE = 1e-3;

// 差の大きさの要約が読む、上側の分位。
const DIFFERENCE_PERCENTILE = 0.99;

// 差の大きさの要約。値はどれも要約に渡した尺度を掛けたもの。
export interface DifferenceSummary {
  // 再投影のある画素の、面のある画素に対する割合。
  readonly reprojectedFraction: number;
  // 再投影のある画素の、差といまの値それぞれの成分の二乗の平均の平方根。
  readonly differenceRms: number;
  readonly valueRms: number;
  // 再投影のある画素の、差の成分の絶対値の最大の、DIFFERENCE_PERCENTILE の分位と最大。
  readonly differencePercentile: number;
  readonly differenceMax: number;
}

// いまのフレームの素の深度 depth(r。面の無い画素は 0)とカメラ camera で、各画素の表面の点が前のフレームのカメラ
// previousCamera で写る画素の座標(画素の中心が整数、行は上から)を、画素ごとに x, y の順で並べて返す。面の無い画素、
// 前のフレームの画面の中に 2×2 の近傍が取れない画素、その近傍の前のフレームの素の深度 previousDepth が写した点と同じ面に
// 乗らない画素(遮蔽の変化と物の縁)は NaN。座標は倍精度 — 同じカメラなら画素の中心から丸めの分しか離れない。
export function reprojectedPixels(
  depth: FloatImage, camera: THREE.Camera, previousDepth: FloatImage, previousCamera: THREE.Camera,
): Float64Array {
  const { width, height } = depth;
  // いまのフレームのクリップ座標から、前のフレームのクリップ座標への写像。
  const toPrevious = new THREE.Matrix4()
    .multiplyMatrices(previousCamera.projectionMatrix, previousCamera.matrixWorldInverse)
    .multiply(camera.matrixWorld)
    .multiply(camera.projectionMatrixInverse);
  const m = toPrevious.elements;
  const out = new Float64Array(width * height * 2).fill(Number.NaN);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = depth.rgba[4 * (y * width + x)]!;
      if (d <= 0) continue;
      // 画素の中心のクリップ座標(WebGPU の座標系。y は上が正)を前のフレームへ写す。
      const cx = 2 * (x + 0.5) / width - 1;
      const cy = 1 - 2 * (y + 0.5) / height;
      const w = m[3]! * cx + m[7]! * cy + m[11]! * d + m[15]!;
      if (w <= 0) continue;
      const px = ((m[0]! * cx + m[4]! * cy + m[8]! * d + m[12]!) / w + 1) / 2 * width - 0.5;
      const py = (1 - (m[1]! * cx + m[5]! * cy + m[9]! * d + m[13]!) / w) / 2 * height - 0.5;
      const pd = (m[2]! * cx + m[6]! * cy + m[10]! * d + m[14]!) / w;
      if (!(px >= 0 && px <= width - 1 && py >= 0 && py <= height - 1)) continue;
      // 近傍の 4 画素がどれも面を持ち、双線形に読んだ素の深度が写した点の深度に合うときだけ、同じ面の点とみなす。
      const taps = bilinearTaps(px, py, width, height);
      if (taps.some(([index]) => previousDepth.rgba[4 * index]! <= 0)) continue;
      const interpolated = taps.reduce((sum, [index, weight]) => sum + weight * previousDepth.rgba[4 * index]!, 0);
      if (Math.abs(interpolated - pd) > SAME_SURFACE_TOLERANCE * pd) continue;
      out[2 * (y * width + x)] = px;
      out[2 * (y * width + x) + 1] = py;
    }
  }
  return out;
}

// 画素の座標 (x, y)(0 ≤ x ≤ width − 1、0 ≤ y ≤ height − 1)を双線形に読む 4 画素の番号と重み。
function bilinearTaps(x: number, y: number, width: number, height: number): readonly (readonly [number, number])[] {
  const x0 = Math.min(Math.floor(x), width - 2);
  const y0 = Math.min(Math.floor(y), height - 2);
  const fx = x - x0;
  const fy = y - y0;
  return [
    [y0 * width + x0, (1 - fx) * (1 - fy)], [y0 * width + x0 + 1, fx * (1 - fy)],
    [(y0 + 1) * width + x0, (1 - fx) * fy], [(y0 + 1) * width + x0 + 1, fx * fy],
  ];
}

// 前のフレームの値 previous を再投影の座標 reprojected(reprojectedPixels)で双線形に読み、いまの値 current から引いた差を
// rgba で返す。rgb は差、α は再投影のある画素で 1、無い画素で 0(rgb も 0)。
export function reprojectedDifference(
  current: FloatImage, previous: FloatImage, reprojected: Float64Array,
): FloatImage {
  const { width, height } = current;
  const rgba = new Float32Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const px = reprojected[2 * p]!;
    if (Number.isNaN(px)) continue;
    const taps = bilinearTaps(px, reprojected[2 * p + 1]!, width, height);
    for (let c = 0; c < 3; c++) {
      const read = taps.reduce((sum, [index, weight]) => sum + weight * previous.rgba[4 * index + c]!, 0);
      rgba[4 * p + c] = current.rgba[4 * p + c]! - read;
    }
    rgba[4 * p + 3] = 1;
  }
  return { width, height, rgba };
}

// 差 difference(reprojectedDifference)と、いまの値 current の大きさを、再投影のある画素について尺度 scale を掛けて要約する。
// surfaceCount は面のある画素の数。
export function differenceSummaryOf(
  difference: FloatImage, current: FloatImage, surfaceCount: number, scale: number,
): DifferenceSummary {
  const magnitudes: number[] = [];
  let differenceSquares = 0;
  let valueSquares = 0;
  for (let p = 0; p < difference.width * difference.height; p++) {
    if (difference.rgba[4 * p + 3] === 0) continue;
    let magnitude = 0;
    for (let c = 0; c < 3; c++) {
      const delta = scale * difference.rgba[4 * p + c]!;
      differenceSquares += delta * delta;
      valueSquares += (scale * current.rgba[4 * p + c]!) ** 2;
      magnitude = Math.max(magnitude, Math.abs(delta));
    }
    magnitudes.push(magnitude);
  }
  const sorted = Float64Array.from(magnitudes).sort();
  const count = sorted.length;
  return {
    reprojectedFraction: surfaceCount > 0 ? count / surfaceCount : 0,
    differenceRms: count > 0 ? Math.sqrt(differenceSquares / (3 * count)) : 0,
    valueRms: count > 0 ? Math.sqrt(valueSquares / (3 * count)) : 0,
    differencePercentile: count > 0 ? sorted[Math.min(count - 1, Math.floor(DIFFERENCE_PERCENTILE * count))]! : 0,
    differenceMax: count > 0 ? sorted[count - 1]! : 0,
  };
}
