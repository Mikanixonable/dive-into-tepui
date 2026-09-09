// 月別の気候入力を2枚だけ読み、同じ全球 UV のサンプルを月境界で補間する。
// 画像は R=気温、G=雲量、B=ETOPO 正高、A=GSHHG 陸地被覆率を 0..1 で持つ。
import * as THREE from 'three/webgpu';
import { mix, texture, uniform, vec2 } from 'three/tsl';
import { DeferredTexture } from '../deferred-texture';
import { equirectUvFromDirection } from './field-projection';
import { eastAt, northAt } from './sphere-frame';
import {
  CLIMATE_CLOUD_MAX,
  CLIMATE_CLOUD_MIN,
  CLIMATE_ELEVATION_MAX_M,
  CLIMATE_ELEVATION_MIN_M,
  CLIMATE_LAND_MAX,
  CLIMATE_LAND_MIN,
  CLIMATE_TEMPERATURE_MAX_K,
  CLIMATE_TEMPERATURE_MIN_K,
  configureClimateTexture,
} from './climate-map';
import type { ClimateMapLike } from './climate-map';
import type { FloatNode, FloatUniform, Vec2Node, Vec3Node, Vec4Node } from '../tsl-types';

export type ClimateUvAt = (direction: Vec3Node) => Vec2Node;

export const MONTHS_PER_YEAR = 12;
const SLOPE_STEP = 0.02;
const EARTH_RADIUS_METERS = 6_371_000;
const SLOPE_STEP_METERS = SLOPE_STEP * 2 * EARTH_RADIUS_METERS;

export type MonthlyClimateRgba = readonly [number, number, number, number];

export type MonthlyClimateTexture = {
  readonly texture: THREE.Texture;
  readonly generation: number;
  request(): void;
  dispose(): void;
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clampBlend(value: number): number {
  return Number.isFinite(value) ? clamp01(value) : 0;
}

export function normalizeClimateMonth(monthIndex: number): number {
  const month = Number.isFinite(monthIndex) ? Math.trunc(monthIndex) : 0;
  return ((month % MONTHS_PER_YEAR) + MONTHS_PER_YEAR) % MONTHS_PER_YEAR;
}

// CPU側の解析テストとデータ検証で共有する RGBA の復号。GPU側の式と同じ線形写像を使う。
export function decodeMonthlyClimateRgba(rgba: MonthlyClimateRgba): {
  readonly temperatureK: number;
  readonly cloudiness: number;
  readonly elevationM: number;
  readonly landFraction: number;
} {
  const [r = 0, g = 0, b = 0, a = 0] = rgba.map(clamp01);
  return {
    temperatureK: CLIMATE_TEMPERATURE_MIN_K
      + r * (CLIMATE_TEMPERATURE_MAX_K - CLIMATE_TEMPERATURE_MIN_K),
    cloudiness: CLIMATE_CLOUD_MIN + g * (CLIMATE_CLOUD_MAX - CLIMATE_CLOUD_MIN),
    elevationM: CLIMATE_ELEVATION_MIN_M
      + b * (CLIMATE_ELEVATION_MAX_M - CLIMATE_ELEVATION_MIN_M),
    landFraction: CLIMATE_LAND_MIN + a * (CLIMATE_LAND_MAX - CLIMATE_LAND_MIN),
  };
}

// 同一 UV で読み取った2枚の RGBAを線形補間してから復号する。各契約値が線形範囲なので、
// チャンネルを先に補間しても復号後に補間しても同じ値になる。
export function mixMonthlyClimateRgba(
  current: MonthlyClimateRgba,
  next: MonthlyClimateRgba,
  blend: number,
): ReturnType<typeof decodeMonthlyClimateRgba> {
  const weight = clampBlend(blend);
  return decodeMonthlyClimateRgba([
    clamp01(current[0]) + (clamp01(next[0]) - clamp01(current[0])) * weight,
    clamp01(current[1]) + (clamp01(next[1]) - clamp01(current[1])) * weight,
    clamp01(current[2]) + (clamp01(next[2]) - clamp01(current[2])) * weight,
    clamp01(current[3]) + (clamp01(next[3]) - clamp01(current[3])) * weight,
  ]);
}

function deferredTexture(url: string): MonthlyClimateTexture {
  const deferred = new DeferredTexture(url, THREE.NoColorSpace);
  configureClimateTexture(deferred.texture);
  return deferred;
}

export class MonthlyClimateMap implements ClimateMapLike {
  private readonly blendNode: FloatUniform = uniform(0);
  private monthIndex = 0;
  private blendValue = 0;
  private generationValue = 0;
  private observedCurrentGeneration = -1;
  private observedNextGeneration = -1;
  private observedMonth = -1;
  private observedBlend = -1;

  public static fromDeferredUrls(urls: readonly string[], uvAt?: ClimateUvAt): MonthlyClimateMap {
    if (urls.length !== MONTHS_PER_YEAR) {
      throw new Error(`Monthly climate requires ${MONTHS_PER_YEAR} URLs`);
    }
    return new MonthlyClimateMap(urls.map(deferredTexture), uvAt);
  }

  // 実GPUを使わない解析テストや別の入力供給元は、DeferredTextureと同じ小さな境界を注入できる。
  public constructor(
    private readonly maps: readonly MonthlyClimateTexture[],
    private readonly uvAt: ClimateUvAt = equirectUvFromDirection,
  ) {
    if (maps.length !== MONTHS_PER_YEAR) {
      throw new Error(`Monthly climate requires ${MONTHS_PER_YEAR} textures`);
    }
    for (const map of maps) configureClimateTexture(map.texture);
  }

  // 月は0始まり。12月の次は1月へ周回し、blendは0..1へ収める。
  public setMonth(monthIndex: number, blend: number): void {
    this.monthIndex = normalizeClimateMonth(monthIndex);
    this.blendValue = clampBlend(blend);
    this.blendNode.value = this.blendValue;
    this.request();
  }

  // 選択中の月と、その次の月だけを取得する。
  public request(): void {
    this.maps[this.monthIndex]?.request();
    this.maps[(this.monthIndex + 1) % MONTHS_PER_YEAR]?.request();
  }

  // 選択と current/next の公開世代を1つの単調な世代へまとめ、雲場キャッシュを無効化する。
  public get generation(): number {
    const currentGeneration = this.maps[this.monthIndex]?.generation ?? 0;
    const nextGeneration = this.maps[(this.monthIndex + 1) % MONTHS_PER_YEAR]?.generation ?? 0;
    if (currentGeneration !== this.observedCurrentGeneration
      || nextGeneration !== this.observedNextGeneration
      || this.monthIndex !== this.observedMonth
      || this.blendValue !== this.observedBlend) {
      this.observedCurrentGeneration = currentGeneration;
      this.observedNextGeneration = nextGeneration;
      this.observedMonth = this.monthIndex;
      this.observedBlend = this.blendValue;
      this.generationValue += 1;
    }
    return this.generationValue;
  }

  public temperatureK(direction: Vec3Node): FloatNode {
    return this.sample(direction).r.mul(CLIMATE_TEMPERATURE_MAX_K - CLIMATE_TEMPERATURE_MIN_K)
      .add(CLIMATE_TEMPERATURE_MIN_K);
  }

  public meanCloudiness(direction: Vec3Node): FloatNode {
    return this.sample(direction).g.mul(CLIMATE_CLOUD_MAX - CLIMATE_CLOUD_MIN).add(CLIMATE_CLOUD_MIN);
  }

  public elevation(direction: Vec3Node): FloatNode {
    return this.sample(direction).b.mul(CLIMATE_ELEVATION_MAX_M - CLIMATE_ELEVATION_MIN_M)
      .add(CLIMATE_ELEVATION_MIN_M);
  }

  public landFraction(direction: Vec3Node): FloatNode {
    return this.sample(direction).a.mul(CLIMATE_LAND_MAX - CLIMATE_LAND_MIN).add(CLIMATE_LAND_MIN);
  }

  public slope(direction: Vec3Node, landHeight: number): Vec2Node {
    const east = eastAt(direction).mul(SLOPE_STEP);
    const north = northAt(direction).mul(SLOPE_STEP);
    const height = (sampleDirection: Vec3Node): FloatNode => this.elevation(sampleDirection)
      .add(this.landFraction(sampleDirection).mul(landHeight));
    return vec2(
      height(direction.add(east)).sub(height(direction.sub(east))).div(SLOPE_STEP_METERS),
      height(direction.add(north)).sub(height(direction.sub(north))).div(SLOPE_STEP_METERS),
    );
  }

  public dispose(): void {
    for (const map of this.maps) map.dispose();
  }

  private sample(direction: Vec3Node): Vec4Node {
    const uv = this.uvAt(direction);
    const current = texture(this.maps[this.monthIndex]!.texture, uv);
    const next = texture(this.maps[(this.monthIndex + 1) % MONTHS_PER_YEAR]!.texture, uv);
    return mix(current, next, this.blendNode) as Vec4Node;
  }
}
