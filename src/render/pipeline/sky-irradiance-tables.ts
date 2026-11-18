// 天体の光学から焼く、水平面へ届く天空光の放射照度表。(太陽の天頂角余弦 mu × 高度) →
// RGB で、大気圏外の太陽放射照度を 1 とする比。単散乱の積分に、等方再散乱の幾何級数を
// 1 次近似で畳み込んだ 2 次以上の簡約を足して焼く(Bruneton 2008・Hillaire 2020 と同じ
// 構成)。視線方向ごとの散乱積分の中で、太陽方向の透過率は焼いた直射表を引き直す —
// 直射光と天空光は同じ経路モデルの値を共有する。
import * as THREE from 'three/webgpu';
import { clamp, sqrt, vec2 } from 'three/tsl';
import { cutoffAltitude, type AtmosphereBody, type AtmosphereOptics } from '../atmosphere';
import {
  TENT_MEAN_DENSITY, depthToSpaceValue, layerDepthValue,
} from './sun-path-depth';
import {
  sampleSunTransmittance, type SunTransmittanceTables,
} from './sun-transmittance-tables';
import type { FloatNode, Vec2Node } from '../tsl-types';

// mu 軸の下端。太陽が局所の地平線の下へ沈んでも、大気の上層が残す薄明の天空光を
// 保持する(sin(−20°) ≈ −0.34。それより下では表の端の値へ張り付く)。
export const SKY_IRRADIANCE_MU_MIN = -0.35;
export const SKY_IRRADIANCE_MU_COUNT = 48;
export const SKY_IRRADIANCE_ALTITUDE_COUNT = 16;

// 半球の方向・視線経路のサンプル数。焼き込みの精度だけの話なので、表の絵が滑らかな
// 範囲で粗く採る。
const SKY_AZIMUTH_COUNT = 16;
const SKY_ZENITH_COUNT = 8;
const SKY_PATH_STEPS = 12;
// 地表の拡散アルベドの代表値。多重散乱が空へ戻す光の概算にだけ使う(海洋優勢の値)。
const GROUND_ALBEDO = 0.2;
// 等方再散乱の級数が発散しないよう止める上限。
const MULTI_SCATTER_FRACTION_MAX = 0.5;

// 天体 1 体ぶんの焼き込んだ天空光表。altitudeMax は高度軸の上限 [m] で、その大気の裾。
export interface SkyIrradianceTable {
  readonly texture: THREE.DataTexture;
  readonly altitudeMax: number;
}

// mu・高度 → 表の uv。高度軸は直射表と同じく √ で潰す。
export function skyIrradianceUv(
  mu: FloatNode, altitude: FloatNode, altitudeMax: FloatNode,
): Vec2Node {
  return vec2(
    mu.sub(SKY_IRRADIANCE_MU_MIN).div(1 - SKY_IRRADIANCE_MU_MIN),
    sqrt(clamp(altitude.div(altitudeMax), 0, 1)),
  );
}

// ---- 焼き込み(純粋計算) ------------------------------------------------------

// Henyey–Greenstein の位相関数(値版。atmosphere-integrator.ts の miePhase と同じ式)。
// 等方散乱を 1 とする基準化値。
function miePhaseValue(cosTheta: number, anisotropy: number): number {
  const squared = anisotropy * anisotropy;
  const denominator = Math.max(squared + 1 - anisotropy * cosTheta * 2, 1e-4);
  return (1 - squared) / (denominator * Math.sqrt(denominator));
}

// 光学 1 体ぶんの表の中身。行は高度(√ 間隔)・列は mu(等間隔)の RGBA。
// 値は大気圏外の太陽放射照度を 1 とする、水平面へ届く天空光の放射照度の比。
export function bakeSkyIrradiance(
  optics: AtmosphereOptics, surfaceRadius: number,
  sunTable: { readonly data: Float32Array; readonly altitudeMax: number },
): { data: Float32Array; altitudeMax: number } {
  const altitudeMax = cutoffAltitude(optics, surfaceRadius);
  const topRadius = surfaceRadius + altitudeMax;
  const data = new Float32Array(SKY_IRRADIANCE_MU_COUNT * SKY_IRRADIANCE_ALTITUDE_COUNT * 4);
  const dPhi = (2 * Math.PI) / SKY_AZIMUTH_COUNT;
  const dTheta = (Math.PI / 2) / SKY_ZENITH_COUNT;
  const rayleigh = [optics.rayleigh.x, optics.rayleigh.y, optics.rayleigh.z];
  const ozoneAbsorption = optics.ozone === undefined ? [0, 0, 0]
    : [optics.ozone.absorption.x, optics.ozone.absorption.y, optics.ozone.absorption.z];
  for (let j = 0; j < SKY_IRRADIANCE_ALTITUDE_COUNT; j++) {
    const v = (j + 0.5) / SKY_IRRADIANCE_ALTITUDE_COUNT;
    const altitude = v * v * altitudeMax;
    const radius = surfaceRadius + altitude;
    for (let i = 0; i < SKY_IRRADIANCE_MU_COUNT; i++) {
      const u = (i + 0.5) / SKY_IRRADIANCE_MU_COUNT;
      const muSun = SKY_IRRADIANCE_MU_MIN + u * (1 - SKY_IRRADIANCE_MU_MIN);
      // 局所座標は東・北・天頂。太陽は方位 0 の面に置く。
      const sunDir = [Math.sqrt(Math.max(1 - muSun * muSun, 0)), 0, muSun] as const;
      const irradiance = [0, 0, 0] as [number, number, number];
      for (let ia = 0; ia < SKY_AZIMUTH_COUNT; ia++) {
        const phi = (ia + 0.5) * dPhi;
        for (let iz = 0; iz < SKY_ZENITH_COUNT; iz++) {
          const theta = (iz + 0.5) * dTheta;
          const sinTheta = Math.sin(theta);
          const cosTheta = Math.cos(theta);
          // 天頂半球の方向。視線の起点は (0,0,radius) なので、方向は (x,y,cosTheta)。
          const dirX = sinTheta * Math.cos(phi);
          const dirY = sinTheta * Math.sin(phi);
          const weight = cosTheta * sinTheta * dTheta * dPhi;
          // 視線が大気の裾球へ出るまでの距離(上半球なので必ず出る)。
          const along = radius * cosTheta;
          const segmentLength = -along
            + Math.sqrt(along * along - radius * radius + topRadius * topRadius);
          const ds = segmentLength / SKY_PATH_STEPS;
          const cosPsi = dirX * sunDir[0] + cosTheta * sunDir[2];
          const phaseRayleigh = 0.75 * (1 + cosPsi * cosPsi);
          const phaseMie = miePhaseValue(cosPsi, optics.mieAnisotropy);
          const radiance = [0, 0, 0] as [number, number, number];
          for (let step = 0; step < SKY_PATH_STEPS; step++) {
            const s = (step + 0.5) * ds;
            const px = dirX * s;
            const py = dirY * s;
            const pz = radius + cosTheta * s;
            const sampleRadius = Math.sqrt(px * px + py * py + pz * pz);
            const sampleAltitude = Math.max(sampleRadius - surfaceRadius, 0);
            const upX = px / sampleRadius;
            const upY = py / sampleRadius;
            const upZ = pz / sampleRadius;
            const muView = upX * dirX + upY * dirY + upZ * cosTheta;
            const muSunAt = upX * sunDir[0] + upY * sunDir[1] + upZ * sunDir[2];
            // 起点からこの点までの視線の透過率。指数分布の区間の厚みは、両端から
            // 大気の外へ抜ける厚みの差(atmosphere-integrator の transmittanceTo と同じ形)。
            const segmentRayleigh = Math.max(0, depthToSpaceValue(
              radius, cosTheta, surfaceRadius, optics.rayleighScaleHeight,
            ) - depthToSpaceValue(
              sampleRadius, muView, surfaceRadius, optics.rayleighScaleHeight,
            ));
            const segmentMie = Math.max(0, depthToSpaceValue(
              radius, cosTheta, surfaceRadius, optics.mieScaleHeight,
            ) - depthToSpaceValue(
              sampleRadius, muView, surfaceRadius, optics.mieScaleHeight,
            ));
            const segmentOzone = optics.ozone === undefined ? 0 : Math.max(0, layerDepthValue(
              radius, cosTheta, surfaceRadius, optics.ozone.centerAltitude, optics.ozone.halfThickness,
            ) - layerDepthValue(
              sampleRadius, muView, surfaceRadius, optics.ozone.centerAltitude, optics.ozone.halfThickness,
            )) * TENT_MEAN_DENSITY;
            const sun = sampleSunTransmittance(sunTable.data, sunTable.altitudeMax, muSunAt, sampleAltitude);
            const densityRayleigh = Math.exp(-sampleAltitude / optics.rayleighScaleHeight);
            const densityMie = Math.exp(-sampleAltitude / optics.mieScaleHeight);
            for (let c = 0; c < 3; c++) {
              const view = Math.exp(-(
                rayleigh[c]! * segmentRayleigh
                + optics.mie * segmentMie
                + ozoneAbsorption[c]! * segmentOzone
              ));
              const scattering = rayleigh[c]! * densityRayleigh * phaseRayleigh
                + optics.mie * densityMie * phaseMie;
              radiance[c] = radiance[c]! + view * scattering * sun[c]! * ds;
            }
          }
          for (let c = 0; c < 3; c++) irradiance[c] = irradiance[c]! + weight * radiance[c]!;
        }
      }
      // 位相関数は ∫p dΩ = 4π に規格化してあるので、放射照度は 1/4π が出る。
      // 2 次以上の散乱は、等方へ再散乱した光が戻る割合の幾何級数として畳む。
      // 割合の目安は (残った光の半分が下向きへ再散乱) × (地表反射の寄与)。
      const sun = sampleSunTransmittance(sunTable.data, sunTable.altitudeMax, muSun, altitude);
      const sunMean = (sun[0] + sun[1] + sun[2]) / 3;
      const multiple = Math.min(
        0.5 * (1 - sunMean) * (1 + GROUND_ALBEDO), MULTI_SCATTER_FRACTION_MAX,
      );
      const at = (j * SKY_IRRADIANCE_MU_COUNT + i) * 4;
      for (let c = 0; c < 3; c++) {
        data[at + c] = (irradiance[c]! / (4 * Math.PI)) / (1 - multiple);
      }
      data[at + 3] = 1;
    }
  }
  return { data, altitudeMax };
}

// 光学 1 組へ 1 枚ぶんの表の持ち主。焼き込みは光学(と半径)ごとに 1 回だけ。
export class SkyIrradianceTables {
  private readonly cache = new WeakMap<AtmosphereOptics, {
    surfaceRadius: number;
    table: SkyIrradianceTable;
  }>();
  private readonly tables = new Set<THREE.DataTexture>();
  // 空きスロットが読む 1×1 の黒(寄与なし)。
  private readonly emptyTexture: THREE.DataTexture;

  // 天空光の積分が読む直射表は同じ持ち主から借りる — 両方の表が同じ経路モデルの
  // 値を共有するため、直射表の焼き込みを天空光側へ渡す。
  public constructor(
    private readonly sunTables: SunTransmittanceTables,
  ) {
    this.emptyTexture = this.toTexture(new Float32Array([0, 0, 0, 1]), 1, 1);
  }

  // 天体の光学から焼いた表。同じ光学では初回だけ焼く。
  public forBody(body: AtmosphereBody): SkyIrradianceTable {
    const cached = this.cache.get(body.optics);
    if (cached !== undefined && cached.surfaceRadius === body.surfaceRadius) return cached.table;
    const { data, altitudeMax } = bakeSkyIrradiance(
      body.optics, body.surfaceRadius, this.sunTables.sunDataFor(body),
    );
    const table: SkyIrradianceTable = {
      texture: this.toTexture(data, SKY_IRRADIANCE_MU_COUNT, SKY_IRRADIANCE_ALTITUDE_COUNT),
      altitudeMax,
    };
    this.cache.set(body.optics, { surfaceRadius: body.surfaceRadius, table });
    return table;
  }

  // 空きスロットが読む表。寄与は 0。
  public forEmpty(): SkyIrradianceTable {
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
