// 天体の光学から焼く、直射光の透過率表。(太陽の天頂角余弦 mu × 高度) → RGB 透過率の
// 半精度テクスチャを、光学が変わったときだけ決定的に焼き直して GPU へ渡す。
// RGB 3 係数の指数では出せない、帯域の中の分光の飽和(長い経路で残る光が帯域の赤端へ
// 寄る効果)とオゾン層の高度分布を、純粋計算で焼き込む。
// 係数の波長形状は文献値 — レイリーは Bodhaine et al. (1999)、エーロゾルは
// Ångström α=1.3、オゾンは Chappuis 帯 300 DU — を、その天体の RGB 係数が定める柱量へ
// **帯域実効で一致する倍率**で乗せる。表は「その天体自身の光学の分光的な焼き直し」
// であって、別モデルへの差し替えではない。
import * as THREE from 'three/webgpu';
import { clamp, sqrt, vec2 } from 'three/tsl';
import { cutoffAltitude, type AtmosphereBody, type AtmosphereOptics } from '../atmosphere';
import {
  aerosolColumnShape, ozoneColumnDepth, rayleighColumnDepth, solarBandTransmittance,
  solarSpectrumSrgb,
} from '../solar-spectrum';
import {
  TENT_MEAN_DENSITY, depthToSpaceValue, layerDepthValue,
} from './sun-path-depth';
import type { FloatNode, Vec2Node } from '../tsl-types';

// 表の mu 軸の下端。地表の水平線(0)より下は、大気の高い点が「地平線の下へ沈んだあとも
// 届く太陽」のぶん。高度 100 km でも地平線の dip は約 0.18 — それより下へはどの高度でも
// ほぼ 0 で切れる。
export const SUN_TRANSMITTANCE_MU_MIN = -0.25;
export const SUN_TRANSMITTANCE_MU_COUNT = 64;
export const SUN_TRANSMITTANCE_ALTITUDE_COUNT = 32;

// 天体 1 体ぶんの焼き込んだ透過率表。altitudeMax は高度軸の上限 [m] で、その大気の裾。
export interface SunTransmittanceTable {
  readonly texture: THREE.DataTexture;
  readonly altitudeMax: number;
}

// 焼いた表の中身を CPU で (mu, 高度) へ双線形に引く。天空光の焼き込みが経路ごとの
// 太陽方向の透過率として、テストが GPU と同じ参照として使う。
export function sampleSunTransmittance(
  data: Float32Array, altitudeMax: number, mu: number, altitude: number,
): readonly [number, number, number] {
  const u = Math.min(Math.max((mu - SUN_TRANSMITTANCE_MU_MIN) / (1 - SUN_TRANSMITTANCE_MU_MIN), 0), 1)
    * (SUN_TRANSMITTANCE_MU_COUNT - 1);
  const v = Math.sqrt(Math.min(Math.max(altitude / altitudeMax, 0), 1))
    * (SUN_TRANSMITTANCE_ALTITUDE_COUNT - 1);
  const i0 = Math.min(Math.floor(u), SUN_TRANSMITTANCE_MU_COUNT - 2);
  const j0 = Math.min(Math.floor(v), SUN_TRANSMITTANCE_ALTITUDE_COUNT - 2);
  const fu = u - i0;
  const fv = v - j0;
  const rgb = [0, 0, 0] as [number, number, number];
  for (let dj = 0; dj <= 1; dj++) {
    for (let di = 0; di <= 1; di++) {
      const w = (di === 0 ? 1 - fu : fu) * (dj === 0 ? 1 - fv : fv);
      const at = ((j0 + dj) * SUN_TRANSMITTANCE_MU_COUNT + (i0 + di)) * 4;
      rgb[0] += w * data[at]!;
      rgb[1] += w * data[at + 1]!;
      rgb[2] += w * data[at + 2]!;
    }
  }
  return rgb;
}

// mu・高度 → 表の uv。高度軸は √ で潰して、裾までの区間を薄い大気の急峻な変化の
// ある低高度へ寄せる。
export function sunTransmittanceUv(
  mu: FloatNode, altitude: FloatNode, altitudeMax: FloatNode,
): Vec2Node {
  return vec2(
    mu.sub(SUN_TRANSMITTANCE_MU_MIN).div(1 - SUN_TRANSMITTANCE_MU_MIN),
    sqrt(clamp(altitude.div(altitudeMax), 0, 1)),
  );
}

// ---- 焼き込み(純粋計算) ------------------------------------------------------

// 帯域実効で target の柱の光学的厚みへ一致する、分光形状の倍率を解く。
// −ln(帯域平均の e^{−k·shape}) は k の単調増加関数なので二分法で足りる。
function fitSpectralScale(
  columnShape: (lambdaUm: number) => number, targetDepth: number,
): number {
  const bandDepthAt = (scale: number): number =>
    -Math.log(solarBandTransmittance((l) => scale * columnShape(l))[1]);
  let lo = 0;
  let hi = 1;
  while (bandDepthAt(hi) < targetDepth) hi *= 4;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (bandDepthAt(mid) < targetDepth) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// 天体の RGB 係数が定める柱量へ、分光形状を乗せた λ [µm] → 消散係数 [1/m]。
// G 帯へ合わせるのは、RGB 3 係数がいずれも λ⁻⁴ 系の形状の G 位置にほぼ載って
// いるため — 合わせた分光形状の R・B 帯実効は、宣言の係数から数 % 以内に収まる。
interface SpectralExtinction {
  readonly rayleigh: (lambdaUm: number) => number;
  readonly mie: (lambdaUm: number) => number;
  readonly ozone: (lambdaUm: number) => number;
}
function spectralExtinctionOf(optics: AtmosphereOptics): SpectralExtinction {
  // 係数 1/m = 帯域実効の柱 / その成分の柱の高さで換算し、波長形状を掛ける。
  const kRayleigh = fitSpectralScale(
    rayleighColumnDepth, optics.rayleigh.y * optics.rayleighScaleHeight,
  );
  const kMie = fitSpectralScale(aerosolColumnShape, optics.mie * optics.mieScaleHeight);
  const ozone = optics.ozone;
  const kOzone = ozone === undefined ? 0
    : fitSpectralScale(ozoneColumnDepth, ozone.absorption.y * ozone.halfThickness);
  const ozoneColumn = ozone?.halfThickness ?? 1;
  return {
    rayleigh: (l) => (kRayleigh * rayleighColumnDepth(l)) / optics.rayleighScaleHeight,
    mie: (l) => (kMie * aerosolColumnShape(l)) / optics.mieScaleHeight,
    // 層の経路の係数はピーク密度目盛り — テントの平均 0.5 は経路長側が畳み込む。
    ozone: (l) => (kOzone * ozoneColumnDepth(l)) / ozoneColumn,
  };
}

// 光学 1 体ぶんの表の中身。行は高度(√ 間隔)・列は mu(等間隔)の RGBA。
export function bakeSunTransmittance(
  optics: AtmosphereOptics, surfaceRadius: number,
): { data: Float32Array; altitudeMax: number } {
  const altitudeMax = cutoffAltitude(optics, surfaceRadius);
  const extinction = spectralExtinctionOf(optics);
  const ozone = optics.ozone;
  const data = new Float32Array(SUN_TRANSMITTANCE_MU_COUNT * SUN_TRANSMITTANCE_ALTITUDE_COUNT * 4);
  for (let j = 0; j < SUN_TRANSMITTANCE_ALTITUDE_COUNT; j++) {
    const v = (j + 0.5) / SUN_TRANSMITTANCE_ALTITUDE_COUNT;
    const altitude = v * v * altitudeMax;
    const radius = surfaceRadius + altitude;
    for (let i = 0; i < SUN_TRANSMITTANCE_MU_COUNT; i++) {
      const u = (i + 0.5) / SUN_TRANSMITTANCE_MU_COUNT;
      const mu = SUN_TRANSMITTANCE_MU_MIN + u * (1 - SUN_TRANSMITTANCE_MU_MIN);
      const rayleighDepth = depthToSpaceValue(radius, mu, surfaceRadius, optics.rayleighScaleHeight);
      const mieDepth = depthToSpaceValue(radius, mu, surfaceRadius, optics.mieScaleHeight);
      const ozoneDepth = ozone === undefined ? 0 : layerDepthValue(
        radius, mu, surfaceRadius, ozone.centerAltitude, ozone.halfThickness,
      ) * TENT_MEAN_DENSITY;
      const [r, g, b] = solarSpectrumSrgb((lambdaUm) => (
        extinction.rayleigh(lambdaUm) * rayleighDepth
        + extinction.mie(lambdaUm) * mieDepth
        + extinction.ozone(lambdaUm) * ozoneDepth
      ));
      const at = (j * SUN_TRANSMITTANCE_MU_COUNT + i) * 4;
      data[at] = r;
      data[at + 1] = g;
      data[at + 2] = b;
      data[at + 3] = 1;
    }
  }
  return { data, altitudeMax };
}

// 光学 1 組へ 1 枚ぶんの表の持ち主。焼き込みは光学(と半径)ごとに 1 回だけ — 使い回しの
// 表をスロット側がフレームごとに指し直す。
export class SunTransmittanceTables {
  private readonly cache = new WeakMap<AtmosphereOptics, {
    surfaceRadius: number;
    data: Float32Array;
    table: SunTransmittanceTable;
  }>();
  private readonly tables = new Set<THREE.DataTexture>();
  // 空きスロットが読む 1×1 の白(素通し)。
  private readonly emptyTexture: THREE.DataTexture;

  public constructor() {
    this.emptyTexture = this.toTexture(new Float32Array([1, 1, 1, 1]), 1, 1);
  }

  // 天体の光学から焼いた表。同じ光学では初回だけ焼く。
  public forBody(body: AtmosphereBody): SunTransmittanceTable {
    const cached = this.cache.get(body.optics);
    if (cached !== undefined && cached.surfaceRadius === body.surfaceRadius) return cached.table;
    const { data, altitudeMax } = bakeSunTransmittance(body.optics, body.surfaceRadius);
    const table: SunTransmittanceTable = {
      texture: this.toTexture(
        data, SUN_TRANSMITTANCE_MU_COUNT, SUN_TRANSMITTANCE_ALTITUDE_COUNT,
      ),
      altitudeMax,
    };
    this.cache.set(body.optics, { surfaceRadius: body.surfaceRadius, data, table });
    return table;
  }

  // 焼いた表の中身を CPU で読む口。天空光の焼き込みが太陽方向の透過率として引き直す。
  public sunDataFor(body: AtmosphereBody): { readonly data: Float32Array; readonly altitudeMax: number } {
    this.forBody(body);
    const cached = this.cache.get(body.optics)!;
    return { data: cached.data, altitudeMax: cached.table.altitudeMax };
  }

  // 空きスロットが読む表。透過率は全帯域で 1(素通し)。
  public forEmpty(): SunTransmittanceTable {
    return { texture: this.emptyTexture, altitudeMax: 1 };
  }

  private toTexture(data: Float32Array, width: number, height: number): THREE.DataTexture {
    // 半精度テクスチャの中身は 16bit の列で渡す — Float32Array のまま置くと
    // 32bit の値が半精度 2 個として読み直されて値が壊れる。
    const texels = new Uint16Array(data.length);
    for (let i = 0; i < data.length; i++) texels[i] = THREE.DataUtils.toHalfFloat(data[i]!);
    const texture = new THREE.DataTexture(
      texels, width, height, THREE.RGBAFormat, THREE.HalfFloatType,
      THREE.UVMapping, THREE.ClampToEdgeWrapping, THREE.ClampToEdgeWrapping,
      THREE.LinearFilter, THREE.LinearFilter, 1,
    );
    texture.needsUpdate = true;
    this.tables.add(texture);
    return texture;
  }

  // 焼いた表をすべて解放する。
  public dispose(): void {
    for (const texture of this.tables) texture.dispose();
    this.tables.clear();
  }
}
