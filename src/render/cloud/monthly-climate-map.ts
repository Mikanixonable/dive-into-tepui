// 月別の気候入力のうち、選択中の月と次の月の2枚を読み、同じ UV の標本を月のあいだで補間する。
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
import type { ClimateMap } from './climate-map';
import type { FloatNode, FloatUniform, Vec2Node, Vec3Node, Vec4Node } from '../tsl-types';

// 単位方向を気候テクスチャの UV へ写す関数。
export type ClimateUvAt = (direction: Vec3Node) => Vec2Node;

export const MONTHS_PER_YEAR = 12;

// 気候テクスチャ 1 texel の RGBA(各 0..1)。
export type MonthlyClimateRgba = readonly [number, number, number, number];

// 1 か月ぶんの気候テクスチャ。generation は画像が GPU へ公開されるたびに進み、0 なら未公開。
export interface MonthlyClimateTexture {
  readonly texture: THREE.Texture;
  readonly generation: number;
  request(): void;
  dispose(): void;
}

// value を 0..1 へ切り詰める。
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

// 補間率を 0..1 へ切り詰める。有限でなければ 0。
function clampBlend(value: number): number {
  return Number.isFinite(value) ? clamp01(value) : 0;
}

// 月の索引を 0..11 へ畳む。負の索引は年の終わりから数え、有限でなければ 0。
export function normalizeClimateMonth(monthIndex: number): number {
  const month = Number.isFinite(monthIndex) ? Math.trunc(monthIndex) : 0;
  return ((month % MONTHS_PER_YEAR) + MONTHS_PER_YEAR) % MONTHS_PER_YEAR;
}

// RGBA(各 0..1、外れた値は切り詰める)を気候の値へ復号する。GPU 側の読み出しと同じ線形写像。
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

// url の画像を、取得を request() まで遅らせた気候テクスチャとして用意する。
function deferredTexture(url: string): MonthlyClimateTexture {
  const deferred = new DeferredTexture(url, THREE.NoColorSpace);
  configureClimateTexture(deferred.texture);
  return deferred;
}

export class MonthlyClimateMap implements ClimateMap {
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

  // 12 か月ぶんの urls(1 月から)を、取得を遅らせたテクスチャとして組む。12 本でなければ例外。
  public static fromDeferredUrls(urls: readonly string[], uvAt?: ClimateUvAt): MonthlyClimateMap {
    if (urls.length !== MONTHS_PER_YEAR) {
      throw new Error(`Monthly climate requires ${MONTHS_PER_YEAR} URLs`);
    }
    return new MonthlyClimateMap(urls.map(deferredTexture), uvAt);
  }

  // 12 か月ぶんのテクスチャ maps(1 月から)で組む。12 枚でなければ例外。uvAt は単位方向から UV への
  // 写しで、既定は正距円筒。
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

  // 12 枚を urls へ差し替える。新しい組は選択中の2枚が GPU へ公開されるまで控えに置き、それまでは
  // 今の入力を読む。破棄後は何もしない。
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

  // 選択中の月と次の月の画像の取得を始める。控えがあれば控えの側を取得する。
  public request(): void {
    const maps = this.pendingMaps ?? this.maps;
    maps[this.monthIndex]?.request();
    maps[(this.monthIndex + 1) % MONTHS_PER_YEAR]?.request();
  }

  // 入力の世代。月・補間率の選択か、その2枚の公開が変わるたびに 1 進む。読むと、選択中の2枚が
  // 公開された控えを今の入力へ入れ替える。
  public get generation(): number {
    this.promotePendingMaps();
    // 前に読んだときから選択か公開が変わっていれば、世代を進める。
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

  // 平均気温 [K]。
  public temperatureK(direction: Vec3Node): FloatNode {
    return this.sample(direction).r.mul(CLIMATE_TEMPERATURE_MAX_K - CLIMATE_TEMPERATURE_MIN_K)
      .add(CLIMATE_TEMPERATURE_MIN_K);
  }

  // 雲量 0..1。
  public meanCloudiness(direction: Vec3Node): FloatNode {
    return this.sample(direction).g.mul(CLIMATE_CLOUD_MAX - CLIMATE_CLOUD_MIN).add(CLIMATE_CLOUD_MIN);
  }

  // 標高 [m]。陸地被覆率が 0 の所(海)では 0。
  public elevation(direction: Vec3Node): FloatNode {
    const raw = this.sample(direction).b.mul(CLIMATE_ELEVATION_MAX_M - CLIMATE_ELEVATION_MIN_M)
      .add(CLIMATE_ELEVATION_MIN_M);
    return select(greaterThan(this.landFraction(direction), 0), raw, float(0));
  }

  // 陸地被覆率 0..1。
  public landFraction(direction: Vec3Node): FloatNode {
    return this.sample(direction).a.mul(CLIMATE_LAND_MAX - CLIMATE_LAND_MIN).add(CLIMATE_LAND_MIN);
  }

  // 斜面の勾配(東向き・北向き成分)[m/m]。landHeight [m] は陸へ上乗せする高さ、surfaceRadius [m] は
  // この天体の半径。
  public slope(direction: Vec3Node, landHeight: number, surfaceRadius: number): Vec2Node {
    return climateSlope(this, direction, landHeight, surfaceRadius);
  }

  // 12 枚と控えのテクスチャを解放する。二度目からは何もしない。
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const map of this.maps) map.dispose();
    for (const map of this.pendingMaps ?? []) map.dispose();
    this.pendingMaps = null;
  }

  // 単位方向 direction の、選択中の2枚を補間率で混ぜた RGBA(各 0..1)。
  private sample(direction: Vec3Node): Vec4Node {
    const uv = this.uvAt(direction);
    const current = this.currentTextureNode.sample(uv);
    const next = this.nextTextureNode.sample(uv);
    return mix(current, next, this.blendNode) as Vec4Node;
  }

  // 読むテクスチャノードを、選択中の月と次の月の2枚へ差し替える。
  private syncTextureNodes(): void {
    this.currentTextureNode.value = this.maps[this.monthIndex]!.texture;
    this.nextTextureNode.value = this.maps[(this.monthIndex + 1) % MONTHS_PER_YEAR]!.texture;
  }

  // 控えのうち選択中の2枚が GPU へ公開されていれば、控えを今の入力へ入れ替えて前の組を解放する。
  private promotePendingMaps(): void {
    const pending = this.pendingMaps;
    if (pending === null) return;
    // 選択中の2枚が揃うまで待つ。
    const current = pending[this.monthIndex];
    const next = pending[(this.monthIndex + 1) % MONTHS_PER_YEAR];
    if ((current?.generation ?? 0) === 0 || (next?.generation ?? 0) === 0) return;
    // 入れ替えて、読むノードと公開の観測を引き直す。
    const previous = this.maps;
    this.maps = pending;
    this.pendingMaps = null;
    this.syncTextureNodes();
    for (const map of previous) map.dispose();
    this.observedCurrentGeneration = -1;
    this.observedNextGeneration = -1;
  }
}
