// 月別の気候入力を2枚だけ読み、同じ全球 UV のサンプルを月境界で補間する。
// 画像は R=気温、G=雲量、B=ETOPO 正高、A=GSHHG 陸地被覆率を 0..1 で持つ。
import * as THREE from 'three/webgpu';
import { float, greaterThan, mix, select, texture, uniform } from 'three/tsl';
import { DeferredTexture } from '../deferred-texture';
import { equirectUvFromDirection } from './field-projection';
import {
  CLIMATE_CLOUD_MAX,
  CLIMATE_CLOUD_MIN,
  CLIMATE_ELEVATION_MAX_M,
  CLIMATE_ELEVATION_MIN_M,
  CLIMATE_LAND_MAX,
  CLIMATE_LAND_MIN,
  CLIMATE_TEMPERATURE_MAX_K,
  CLIMATE_TEMPERATURE_MIN_K,
  climateSlope,
  configureClimateTexture,
} from './climate-map';
import type { ClimateMapLike } from './climate-map';
import type { FloatNode, FloatUniform, Vec2Node, Vec3Node, Vec4Node } from '../tsl-types';

export type ClimateUvAt = (direction: Vec3Node) => Vec2Node;

export const MONTHS_PER_YEAR = 12;

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
  private readonly currentTextureNode: ReturnType<typeof texture>;
  private readonly nextTextureNode: ReturnType<typeof texture>;
  private monthIndex = 0;
  private blendValue = 0;
  private generationValue = 0;
  private observedCurrentGeneration = -1;
  private observedNextGeneration = -1;
  private observedMonth = -1;
  private observedBlend = -1;
  private disposed = false;
  private pendingMaps: readonly MonthlyClimateTexture[] | null = null;

  public static fromDeferredUrls(urls: readonly string[], uvAt?: ClimateUvAt): MonthlyClimateMap {
    if (urls.length !== MONTHS_PER_YEAR) {
      throw new Error(`Monthly climate requires ${MONTHS_PER_YEAR} URLs`);
    }
    return new MonthlyClimateMap(urls.map(deferredTexture), uvAt);
  }

  // 実GPUを使わない解析テストや別の入力供給元は、DeferredTextureと同じ小さな境界を注入できる。
  public constructor(
    maps: readonly MonthlyClimateTexture[],
    private readonly uvAt: ClimateUvAt = equirectUvFromDirection,
  ) {
    if (maps.length !== MONTHS_PER_YEAR) {
      throw new Error(`Monthly climate requires ${MONTHS_PER_YEAR} textures`);
    }
    this.maps = maps;
    for (const map of maps) configureClimateTexture(map.texture);
    this.currentTextureNode = texture(maps[0]!.texture);
    this.nextTextureNode = texture(maps[1]!.texture);
  }

  private maps: readonly MonthlyClimateTexture[];

  // 配信版の12枚を準備し、現在の入力を保ったままcurrent/nextだけを要求する。
  public replaceUrls(urls: readonly string[]): void {
    if (this.disposed) return;
    if (urls.length !== MONTHS_PER_YEAR) {
      throw new Error(`Monthly climate requires ${MONTHS_PER_YEAR} URLs`);
    }
    const maps = urls.map(deferredTexture);
    for (const map of this.pendingMaps ?? []) map.dispose();
    this.pendingMaps = maps;
  }

  // 月は0始まり。12月の次は1月へ周回し、blendは0..1へ収める。
  public setMonth(monthIndex: number, blend: number): void {
    this.monthIndex = normalizeClimateMonth(monthIndex);
    this.blendValue = clampBlend(blend);
    this.blendNode.value = this.blendValue;
    this.syncTextureNodes();
    this.request();
  }

  // 選択中の月と、その次の月だけを取得する。
  public request(): void {
    const maps = this.pendingMaps ?? this.maps;
    maps[this.monthIndex]?.request();
    maps[(this.monthIndex + 1) % MONTHS_PER_YEAR]?.request();
  }

  // 選択と current/next の公開世代を1つの単調な世代へまとめ、雲場キャッシュを無効化する。
  public get generation(): number {
    this.promotePendingMaps();
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
    const raw = this.sample(direction).b.mul(CLIMATE_ELEVATION_MAX_M - CLIMATE_ELEVATION_MIN_M)
      .add(CLIMATE_ELEVATION_MIN_M);
    return select(greaterThan(this.landFraction(direction), 0), raw, float(0));
  }

  public landFraction(direction: Vec3Node): FloatNode {
    return this.sample(direction).a.mul(CLIMATE_LAND_MAX - CLIMATE_LAND_MIN).add(CLIMATE_LAND_MIN);
  }

  // 斜面の勾配(東向き・北向き成分)[m/m]。landHeight [m] は陸へ上乗せする高さ、surfaceRadius [m] は
  // この天体の半径。
  public slope(direction: Vec3Node, landHeight: number, surfaceRadius: number): Vec2Node {
    return climateSlope(this, direction, landHeight, surfaceRadius);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const map of this.maps) map.dispose();
    for (const map of this.pendingMaps ?? []) map.dispose();
    this.pendingMaps = null;
  }

  private sample(direction: Vec3Node): Vec4Node {
    const uv = this.uvAt(direction);
    const current = this.currentTextureNode.sample(uv);
    const next = this.nextTextureNode.sample(uv);
    return mix(current, next, this.blendNode) as Vec4Node;
  }

  private syncTextureNodes(): void {
    this.currentTextureNode.value = this.maps[this.monthIndex]!.texture;
    this.nextTextureNode.value = this.maps[(this.monthIndex + 1) % MONTHS_PER_YEAR]!.texture;
  }

  private promotePendingMaps(): void {
    const pending = this.pendingMaps;
    if (pending === null) return;
    const current = pending[this.monthIndex];
    const next = pending[(this.monthIndex + 1) % MONTHS_PER_YEAR];
    if ((current?.generation ?? 0) === 0 || (next?.generation ?? 0) === 0) return;
    const previous = this.maps;
    this.maps = pending;
    this.pendingMaps = null;
    this.syncTextureNodes();
    for (const map of previous) map.dispose();
    this.observedCurrentGeneration = -1;
    this.observedNextGeneration = -1;
  }
}
