// 地球・月で共有する表面ノード。
// 画像は既存の8K資産だけを使い、土地被覆と地形高は画像のチャンネルから得る代理値に
// 留める。後日実測マスク/標高テクスチャを差し替えても、材質の合成則は維持できる。
import * as THREE from 'three/webgpu';
import {
  abs,
  clamp,
  cross,
  dot,
  float,
  mix,
  normalize,
  positionLocal,
  smoothstep,
  texture as textureNode,
  uv,
  vec2,
  vec3,
  uniform,
  normalLocal,
} from 'three/tsl';
import {
  ICE_AGE_EARTH,
  seasonalLongitudeAt,
  SurfaceMaterialMasks,
} from '../physics/surface-material';
import { EarthCloudNodes, createEarthCloudNodes } from './earth-clouds';

type TslNode = ReturnType<typeof textureNode>;

export interface EarthClimateUniforms {
  readonly snowPersistence: ReturnType<typeof uniform>;
  readonly vegetationActivity: ReturnType<typeof uniform>;
  readonly seaIceExpansion: ReturnType<typeof uniform>;
  readonly solarLongitude: ReturnType<typeof uniform>;
}

export interface EarthSurfaceNodes {
  readonly baseColor: TslNode;
  readonly oceanMask: TslNode;
  readonly landMask: TslNode;
  readonly iceMask: TslNode;
  readonly vegetationMask: TslNode;
  readonly terrainNormal: TslNode;
  readonly clouds: EarthCloudNodes;
  readonly climate: EarthClimateUniforms;
  readonly setSeasonalTime: (timeSeconds: number) => void;
}

export interface MoonSurfaceNodes {
  readonly baseColor: TslNode;
  readonly terrainNormal: TslNode;
}

function terrainNormalNode(map: THREE.Texture, texel: number, strength: number, detail = 0): TslNode {
  const coord = uv();
  const height = (offsetU: number, offsetV: number): TslNode => {
    const sample = textureNode(map, coord.add(vec2(offsetU, offsetV)));
    return dot(sample, vec3(0.2126, 0.7152, 0.0722));
  };
  const dU = height(texel, 0).sub(height(-texel, 0)).mul(0.5 * strength);
  const dV = height(0, texel).sub(height(0, -texel)).mul(0.5 * strength);
  const radial = normalize(positionLocal);
  const east = normalize(vec3(normalLocal.z.negate(), 0, normalLocal.x));
  const north = normalize(cross(east, radial));
  const procedural = vec3(
    positionLocal.x.add(positionLocal.z.mul(1.71)).mul(31.7).sin(),
    positionLocal.y.mul(27.3).cos(),
    positionLocal.z.sub(positionLocal.x.mul(0.83)).mul(23.1).sin(),
  ).mul(detail);
  return normalize(radial.sub(east.mul(dU)).sub(north.mul(dV)).add(procedural));
}

function earthLandMask(color: TslNode): TslNode {
  // 海は青成分が優勢、陸は緑/赤が青を上回るという8K画像の安定した分離を使う。
  const landSignal = color.g.sub(color.b).add(color.r.sub(color.b).mul(0.35));
  return smoothstep(-0.012, 0.035, landSignal);
}

/** 氷河期・季節係数を反映する地球表面ノードを構築する。 */
export function createEarthSurfaceNodes(
  earthMap: THREE.Texture,
  cloudsMap: THREE.Texture,
  cloudSunDirection: ReturnType<typeof uniform>,
): EarthSurfaceNodes {
  const coord = uv();
  const color = textureNode(earthMap, coord);
  const landMask = earthLandMask(color);
  const oceanMask = landMask.oneMinus();
  const latitude = abs(coord.y.mul(2).sub(1));
  const terrainHeight = clamp(dot(color, vec3(0.2126, 0.7152, 0.0722)), 0, 1);
  const climate: EarthClimateUniforms = {
    snowPersistence: uniform(ICE_AGE_EARTH.glacialBaseline),
    vegetationActivity: uniform(ICE_AGE_EARTH.vegetationRetention),
    seaIceExpansion: uniform(ICE_AGE_EARTH.seaIceExpansion),
    solarLongitude: uniform(0),
  };
  // SphereGeometryではv=0が北。太陽黄経のsinと符号付き緯度を掛け、南北半球で
  // 夏冬を必ず逆相にする。氷河期の恒常氷床を季節項より優先する。
  const signedLatitude = float(1).sub(coord.y.mul(2));
  const localSummer = clamp(float(0.5).add(
    climate.solarLongitude.sin().mul(signedLatitude).mul(0.5),
  ), 0, 1);
  const seasonalSnow = climate.snowPersistence.mul(float(0.78).add(localSummer.oneMinus().mul(0.38)));
  const polarIce = smoothstep(0.64, 0.98, latitude).mul(seasonalSnow);
  const mountainIce = smoothstep(0.58, 0.92, terrainHeight).mul(seasonalSnow.mul(0.5));
  const iceMask = clamp(polarIce.add(mountainIce).mul(landMask).add(
    smoothstep(0.64, 0.98, latitude).mul(landMask.oneMinus()).mul(climate.seaIceExpansion),
  ), 0, 1);
  const greenSignal = smoothstep(0.02, 0.16, color.g.sub(color.r));
  const vegetationMask = landMask.mul(iceMask.oneMinus()).mul(greenSignal)
    .mul(climate.vegetationActivity).mul(float(0.72).add(localSummer.mul(0.38)));
  const clouds = createEarthCloudNodes(cloudsMap, cloudSunDirection);
  const iceColor = vec3(0.77, 0.86, 0.96);
  const vegetationTint = vec3(0.72, 0.92, 0.64);
  const iceLand = mix(color, iceColor, iceMask.mul(0.82));
  const tintedLand = mix(iceLand, iceLand.mul(vegetationTint), vegetationMask.mul(0.34));
  const oceanTint = mix(tintedLand, tintedLand.mul(vec3(0.86, 0.96, 1.08)), oceanMask.mul(0.18));
  return {
    baseColor: oceanTint,
    oceanMask,
    landMask,
    iceMask,
    vegetationMask,
    terrainNormal: terrainNormalNode(earthMap, 1 / 8192, 0.42, 0.018),
    clouds,
    climate,
    setSeasonalTime(timeSeconds: number) {
      climate.snowPersistence.value = ICE_AGE_EARTH.glacialBaseline;
      climate.vegetationActivity.value = ICE_AGE_EARTH.vegetationRetention;
      climate.seaIceExpansion.value = ICE_AGE_EARTH.seaIceExpansion;
      climate.solarLongitude.value = seasonalLongitudeAt(timeSeconds);
      clouds.setTime(timeSeconds);
    },
  };
}

/** 月は画像勾配を強め、同じ画像から得られないクレーター細部を固定detailで補う。 */
export function createMoonSurfaceNodes(moonMap: THREE.Texture): MoonSurfaceNodes {
  const color = textureNode(moonMap, uv());
  return {
    baseColor: color,
    terrainNormal: terrainNormalNode(moonMap, 1 / 8192, 1.8, 0.035),
  };
}

// 純関数マスクの結果をGPUノードへ移すときの型契約を保つための参照。実行時には使わない。
export type SurfaceMaskNodeSet = Readonly<Pick<SurfaceMaterialMasks, 'ocean' | 'land' | 'iceSnow' | 'vegetation' | 'rock'>>;
