// 気候画素(正距円筒 RGB8: R 平均気温 / G 平年の雲量 / B 標高)を CPU の数値で読む部品。
// THREE・DOM に依存しないので、canvas や ImageData を持てない実行環境(worker)でも、
// {width,height,data} の画素列を渡せば気候マップと同じ値を復号できる。uv の取り決め・
// フィルタ(LinearFilter + u 周回 + v 端留め)・目盛りは GPU 経路と同じ。
import type { Vec3 } from '../../math/vec3';
import type { ClimateValues } from './climate-map';

// 画像から取り出した RGB8 の画素列。1 texel は R・G・B・A の 4 byte。
export interface ClimatePixels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array | Uint8ClampedArray;
}

// テクスチャの目盛り。B は 0..8000 m を 0..1 で持つ。
export const ELEVATION_SPAN = 8000;
// 陸らしさが 1 に届く標高 [m]。**標高は海で 0、ぼかしの幅で海岸から立ち上がる**ので、低い値で
// 切れば陸と、その近くの海が読める。海抜の低い平野が海の側へ寄るが、板と粒を分けるのに要る
// のは大陸と大洋の区別なので足りる。
export const LAND_ELEVATION = 100;

function clampValue(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

// 端で立ち上がる滑らかな重み。TSL の smoothstep と同じ式の数値版。
function smoothstepValue(low: number, high: number, value: number): number {
  const t = clampValue((value - low) / (high - low), 0, 1);
  return t * t * (3 - 2 * t);
}

// 単位方向の正距円筒 uv(0..1)。equirectUvFromDirection と同じ取り決めの数値版。
export function equirectUvFromDirectionCpu(direction: Vec3): { readonly u: number; readonly v: number } {
  return {
    u: Math.atan2(direction.x, direction.z) / (2 * Math.PI) + 0.5,
    v: 0.5 - Math.asin(clampValue(direction.y, -1, 1)) / Math.PI,
  };
}

// uv(0..1)の画素値(R・G・B、0..1)を線形補間で読む。u は経度で周回、v は緯度で端に
// 留まる — テクスチャのラップ設定と同じ読み方。
export function sampleBilinear(
  pixels: ClimatePixels, u: number, v: number,
): readonly [number, number, number] {
  const x = u * pixels.width - 0.5;
  const y = v * pixels.height - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const wrapX = (i: number): number => ((i % pixels.width) + pixels.width) % pixels.width;
  const clampY = (j: number): number => clampValue(j, 0, pixels.height - 1);
  const channel = (i: number, j: number, c: number): number =>
    pixels.data[(clampY(j) * pixels.width + wrapX(i)) * 4 + c]! / 255;
  const mix = (c: number): number => {
    const upper = channel(x0, y0, c) + (channel(x0 + 1, y0, c) - channel(x0, y0, c)) * tx;
    const lower = channel(x0, y0 + 1, c) + (channel(x0 + 1, y0 + 1, c) - channel(x0, y0 + 1, c)) * tx;
    return upper + (lower - upper) * ty;
  };
  return [mix(0), mix(1), mix(2)];
}

// 単位方向の気候値。画素列を正距円筒 uv で線形補間して読み、GPU 経路と同じ目盛りへ復号する。
export function climateValuesAtCpu(direction: Vec3, pixels: ClimatePixels): ClimateValues {
  const { u, v } = equirectUvFromDirectionCpu(direction);
  const [r, g, b] = sampleBilinear(pixels, u, v);
  const elevationM = b * ELEVATION_SPAN;
  return {
    temperatureK: r * 80 + 233.15,
    meanCloudiness: g,
    elevationM,
    landFraction: smoothstepValue(0, LAND_ELEVATION, elevationM),
  };
}
