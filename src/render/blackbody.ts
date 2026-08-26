// 温度から自照の色と明るさを引く表。灰色体の熱放射を、描画が扱う放射量の目盛り
// (pipeline の SUN_IRRADIANCE_1AU)へ写したものを返す。表は起動時に一度だけ組み、
// CPU 側の照合と TSL 側の表引きが同じ 1 つの中身を読む。
import * as THREE from 'three/webgpu';
import { STEFAN_BOLTZMANN } from '../physics/thermal';
import { SOLAR_CONSTANT } from '../physics/srp';
import type { FloatNode, Vec3Node } from './tsl-types';

// 表が張る温度の範囲 [K] と段数。下端は可視域の放射が表示値 1e-6 に届かない温度、上端は
// 固体が固体でいられる温度の上。段の間は線形に補間する(1 段あたりの明るさの比が 1.22 なので
// 補間の誤差は 0.4%)。
const MIN_TEMPERATURE = 800;
const MAX_TEMPERATURE = 3000;
const STEPS = 256;

// 太陽の実効温度 [K]。この温度の黒体が無彩色に写るよう、等色関数の応答をチャンネルごとに
// 正規化する — 描画の白色点が太陽光であることと揃える。
const SUN_TEMPERATURE = 5772;

// 太陽面の輝度を放射量の目盛りへ写した値。目盛りの 1 単位は 1 天文単位で受ける放射照度
// SOLAR_CONSTANT なので、σT⁴/π をそれで割ると、正規化した等色関数の応答へ掛ける係数になる。
const SUN_SURFACE_VALUE = (STEFAN_BOLTZMANN * SUN_TEMPERATURE ** 4) / SOLAR_CONSTANT;

const PLANCK_C1 = 3.741771852e-16; // 2πhc² [W·m²]
const PLANCK_C2 = 1.438776877e-2; // hc/k [m·K]

// 左右で幅の違うガウス。等色関数の各ローブがこの形で表される。
function gauss(x: number, mean: number, sigmaLow: number, sigmaHigh: number): number {
  const t = (x - mean) / (x < mean ? sigmaLow : sigmaHigh);
  return Math.exp(-0.5 * t * t);
}

// 波長 lambda [nm] における CIE 1931 等色関数の3つの応答。多ローブのガウスで近似したもの
// (Wyman et al. 2013)。
function cieResponse(lambda: number): [number, number, number] {
  return [
    1.056 * gauss(lambda, 599.8, 37.9, 31.0)
      + 0.362 * gauss(lambda, 442.0, 16.0, 26.7)
      - 0.065 * gauss(lambda, 501.1, 20.4, 26.2),
    0.821 * gauss(lambda, 568.8, 46.9, 40.5) + 0.286 * gauss(lambda, 530.9, 16.3, 31.1),
    1.217 * gauss(lambda, 437.0, 11.8, 36.0) + 0.681 * gauss(lambda, 459.0, 26.0, 13.8),
  ];
}

// 黒体の分光放射輝度 [W/m²/sr/nm]。lambda は nm、temperature は K。
function planck(lambda: number, temperature: number): number {
  const m = lambda * 1e-9;
  return (PLANCK_C1 / (Math.PI * m ** 5)) / (Math.exp(PLANCK_C2 / (m * temperature)) - 1) * 1e-9;
}

// 温度 temperature の黒体スペクトルを、正規化前の線形 sRGB の3成分へ落とす。
function spectrumToLinearRgb(temperature: number): [number, number, number] {
  // 可視域を 1 nm 刻みで積んで三刺激値を得る。
  let x = 0;
  let y = 0;
  let z = 0;
  for (let lambda = 360; lambda <= 830; lambda++) {
    const radiance = planck(lambda, temperature);
    const [rx, ry, rz] = cieResponse(lambda);
    x += radiance * rx;
    y += radiance * ry;
    z += radiance * rz;
  }
  // 三刺激値から線形 sRGB への変換行列。
  return [
    3.2406 * x - 1.5372 * y - 0.4986 * z,
    -0.9689 * x + 1.8758 * y + 0.0415 * z,
    0.0557 * x - 0.2040 * y + 1.0570 * z,
  ];
}

// 輻射率 1 の黒体が温度 MIN..MAX_TEMPERATURE で見せる表示値を、段ごとに RGB で並べた表。
function buildTable(): Float32Array {
  const white = spectrumToLinearRgb(SUN_TEMPERATURE);
  const table = new Float32Array(STEPS * 3);
  for (let i = 0; i < STEPS; i++) {
    const temperature = MIN_TEMPERATURE + (MAX_TEMPERATURE - MIN_TEMPERATURE) * (i / (STEPS - 1));
    const rgb = spectrumToLinearRgb(temperature);
    for (let c = 0; c < 3; c++) {
      // 色域の外へ出た成分は負になる。負の自照は画素を暗い側へ抜けさせるので、ここで切る。
      table[i * 3 + c] = Math.max(0, (rgb[c]! / white[c]!) * SUN_SURFACE_VALUE);
    }
  }
  return table;
}

const table = buildTable();

let lut: THREE.DataTexture | null = null;

// 表を段の並びそのままに収めた 1 次元テクスチャ。半精度で足りる(収める値域 9e-7〜1.2e3)ので、
// 32bit テクスチャの線形補間を要求せずに済む。
function lutTexture(): THREE.DataTexture {
  if (lut !== null) return lut;
  // 段ごとの RGB を半精度へ落とす。不透明度の枠は使わないので 1 で埋める。
  const texels = new Uint16Array(STEPS * 4);
  for (let i = 0; i < STEPS; i++) {
    for (let c = 0; c < 3; c++) texels[i * 4 + c] = THREE.DataUtils.toHalfFloat(table[i * 3 + c]!);
    texels[i * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
  }
  // 段の間は補間で埋め、表の外は両端の段が伸びる。
  lut = new THREE.DataTexture(texels, STEPS, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  lut.magFilter = THREE.LinearFilter;
  lut.minFilter = THREE.LinearFilter;
  lut.wrapS = THREE.ClampToEdgeWrapping;
  lut.wrapT = THREE.ClampToEdgeWrapping;
  lut.colorSpace = THREE.NoColorSpace;
  lut.needsUpdate = true;
  return lut;
}

// 温度 [K] を表の段の中心を突く横位置(0..1)へ写す。表の外は両端へ張り付く。
function lutCoord(temperature: FloatNode): FloatNode {
  const t = THREE.TSL.clamp(
    temperature.sub(MIN_TEMPERATURE).div(MAX_TEMPERATURE - MIN_TEMPERATURE),
    THREE.TSL.float(0), THREE.TSL.float(1)) as FloatNode;
  return t.mul((STEPS - 1) / STEPS).add(0.5 / STEPS) as FloatNode;
}

// 温度 temperature [K]・輻射率 emissivity の面が自ら放つ光を、放射量の目盛りの表示値で返す。
export function blackbodyEmissiveNode(temperature: FloatNode, emissivity: FloatNode): Vec3Node {
  const uv = THREE.TSL.vec2(lutCoord(temperature), 0.5);
  return THREE.TSL.texture(lutTexture(), uv).rgb.mul(emissivity) as Vec3Node;
}

// 同じ表を CPU 側から引く。較正の照合に使う値で、成分は 1 を超えうる。
export function blackbodyEmissive(
  temperature: number, emissivity: number, out: THREE.Color,
): THREE.Color {
  const t = Math.min(1, Math.max(0,
    (temperature - MIN_TEMPERATURE) / (MAX_TEMPERATURE - MIN_TEMPERATURE))) * (STEPS - 1);
  const i = Math.min(STEPS - 2, Math.floor(t));
  const f = t - i;
  const lerp = (c: number): number =>
    (table[i * 3 + c]! * (1 - f) + table[(i + 1) * 3 + c]! * f) * emissivity;
  return out.setRGB(lerp(0), lerp(1), lerp(2), THREE.LinearSRGBColorSpace);
}
