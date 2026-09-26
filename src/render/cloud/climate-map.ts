// 天体の気候データ入力仕様と、平年の気候テクスチャ(正距円筒 RGB8: R 平均気温 / G 平年の雲量 / B 標高)を
// 読むその実装。気候は雲より桁で低周波な、その天体固有の分布である。GPU 経路は TSL のテクスチャ参照を
// 返し、CPU 経路は画像から取り出した画素を方向の数値へ復号する。
import * as THREE from 'three/webgpu';
import { smoothstep, texture, vec2 } from 'three/tsl';
import { DeferredTexture } from '../deferred-texture';
import { equirectUvFromDirection } from '../field-projection';
import { eastAt, northAt } from './sphere-frame';
import type { Vec3 } from '../../math/vec3';
import type { FloatNode, Vec2Node, Vec3Node, Vec4Node } from '../tsl-types';

// テクスチャの目盛り。B は 0..8000 m を 0..1 で持つ。
const ELEVATION_SPAN = 8000;
// 陸らしさが 1 に届く標高 [m]。**標高は海で 0、ぼかしの幅で海岸から立ち上がる**ので、低い値で
// 切れば陸と、その近くの海が読める。海抜の低い平野が海の側へ寄るが、板と粒を分けるのに要る
// のは大陸と大洋の区別なので足りる。
const LAND_ELEVATION = 100;
// 標高の勾配を取る中心差分の刻み [rad]。テクスチャの texel(2π/512)より大きく、山脈の幅より小さい。
const SLOPE_STEP = 0.02;

// 単位方向で読んだ気候値。GPU 経路と同じ画像・同じ目盛りの量を、CPU が数値として扱う形。
export interface ClimateValues {
  // 平均気温 [K]
  readonly temperatureK: number;
  // 平年の雲量 0..1
  readonly meanCloudiness: number;
  // 標高 [m]
  readonly elevationM: number;
  // 陸らしさ 0..1(大洋で 0、大陸の内側で 1、海岸で渡る)
  readonly landFraction: number;
}

// 天体の気候を単位方向で答える入力。generation は入力(読む画像か、その選択)が変わるたびに進む世代。
export interface ClimateData {
  readonly generation: number;
  temperatureK(direction: Vec3Node): FloatNode;
  meanCloudiness(direction: Vec3Node): FloatNode;
  elevation(direction: Vec3Node): FloatNode;
  landFraction(direction: Vec3Node): FloatNode;
  slope(direction: Vec3Node, landHeight: number, surfaceRadius: number): Vec2Node;
  // 単位方向の気候値を CPU 側で読む。画像がまだ届いていない、または CPU から画素を
  // 読めない形のときは null を返す。
  valuesAtCpu(direction: Vec3): ClimateValues | null;
  request(): void;
  dispose(): void;
}

// climate の標高と陸らしさから、斜面の勾配(東向き・北向き成分)[m/m] を中心差分で引く。
// landHeight [m] は陸へ上乗せする高さで、海と陸の比熱の差で海岸へ吹き込む風が持ち上げられる分を、
// 人工の斜面として代用する。surfaceRadius [m] はこの天体の半径で、勾配を角あたりから長さあたりへ
// 直すのに要る。
export function climateSlope(
  climate: ClimateData, direction: Vec3Node, landHeight: number, surfaceRadius: number,
): Vec2Node {
  const east = eastAt(direction).mul(SLOPE_STEP);
  const north = northAt(direction).mul(SLOPE_STEP);
  // 中心差分の刻みが地表で張る長さ [m]。
  const stepMeters = SLOPE_STEP * 2 * surfaceRadius;
  const height = (d: Vec3Node): FloatNode => climate.elevation(d).add(climate.landFraction(d).mul(landHeight));
  return vec2(
    height(direction.add(east)).sub(height(direction.sub(east))).div(stepMeters),
    height(direction.add(north)).sub(height(direction.sub(north))).div(stepMeters),
  );
}

// 画像から取り出した RGB8 の画素列。1 texel は R・G・B・A の 4 byte。
interface ClimatePixels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array | Uint8ClampedArray;
}

function clampValue(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

// 端で立ち上がる滑らかな重み。TSL の smoothstep と同じ式の数値版。
function smoothstepValue(low: number, high: number, value: number): number {
  const t = clampValue((value - low) / (high - low), 0, 1);
  return t * t * (3 - 2 * t);
}

// テクスチャに載った画像から画素列を取り出す。画素配列を持つ画像(DataTexture など)は
// そのまま読み、画像要素は canvas へ写して読む。DOM の無い環境や画像の未着では null。
function pixelsFromImage(image: unknown): ClimatePixels | null {
  if (typeof image !== 'object' || image === null) return null;
  const source = image as {
    readonly width?: unknown; readonly height?: unknown;
    readonly naturalWidth?: unknown; readonly naturalHeight?: unknown;
    readonly data?: unknown;
  };
  // HTMLImageElement は描画幅を返す width ではなく固有の画素数が要る。
  const width = typeof source.naturalWidth === 'number' ? source.naturalWidth : source.width;
  const height = typeof source.naturalHeight === 'number' ? source.naturalHeight : source.height;
  if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) {
    return null;
  }
  // 画素配列を直接持つ画像(DataTexture の image など)。
  if (source.data !== undefined && source.data !== null) {
    const data = source.data;
    if (data instanceof Uint8Array || data instanceof Uint8ClampedArray) {
      return { width, height, data };
    }
    return null;
  }
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) return null;
  // 読み手が掴む画像はテクスチャの読み込み系(TextureLoader / DeferredTexture)が画像
  // ソースだけを載せることで保証される。
  context.drawImage(source as CanvasImageSource, 0, 0);
  return { width, height, data: context.getImageData(0, 0, width, height).data };
}

// 単位方向の正距円筒 uv(0..1)。equirectUvFromDirection と同じ取り決めの数値版。
function equirectUvFromDirectionCpu(direction: Vec3): { readonly u: number; readonly v: number } {
  return {
    u: Math.atan2(direction.x, direction.z) / (2 * Math.PI) + 0.5,
    v: 0.5 - Math.asin(clampValue(direction.y, -1, 1)) / Math.PI,
  };
}

// uv(0..1)の画素値(R・G・B、0..1)を線形補間で読む。u は経度で周回、v は緯度で端に
// 留まる — テクスチャのラップ設定と同じ読み方。
function sampleBilinear(pixels: ClimatePixels, u: number, v: number): readonly [number, number, number] {
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

// 気候テクスチャを、正距円筒のデータ値のまま線形補間で読める設定にして返す。
function configureClimateTexture(map: THREE.Texture): THREE.Texture {
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;
  map.flipY = false;
  map.generateMipmaps = false;
  map.minFilter = THREE.LinearFilter;
  map.magFilter = THREE.LinearFilter;
  map.colorSpace = THREE.NoColorSpace;
  return map;
}

// 平年(通年で1枚)の気候テクスチャを読む気候入力。
export class AnnualClimateMap implements ClimateData {
  // url の PNG を読み終えてから器を返す。
  public static async load(url: string): Promise<AnnualClimateMap> {
    const map = await new THREE.TextureLoader().loadAsync(url);
    return new AnnualClimateMap(configureClimateTexture(map), null);
  }

  // url の画像の取得を request() まで遅らせる器を返す。
  public static fromDeferredUrl(url: string): AnnualClimateMap {
    const deferred = new DeferredTexture(url, THREE.NoColorSpace);
    return new AnnualClimateMap(configureClimateTexture(deferred.texture), deferred);
  }

  // RGB8 の画素列から気候を組む。画素の並び・目盛りは気候テクスチャと同じ(行 0 が北極、
  // 列 0 が経度 −180°、1 texel は R・G・B・A の 4 byte)。
  public static fromPixels(data: Uint8Array, width: number, height: number): AnnualClimateMap {
    const map = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
    map.needsUpdate = true;
    return new AnnualClimateMap(configureClimateTexture(map), null);
  }

  private constructor(
    private readonly map: THREE.Texture,
    private readonly deferred: DeferredTexture | null,
  ) {}

  // 画素の読み出し。同じ画像の間は取り出しを使い回し、画像が差し替わったら取り直す。
  private cpuPixels: { readonly image: unknown; readonly pixels: ClimatePixels } | null = null;

  // 画像リソースの取得を開始する。fromDeferredUrl で生成された遅延読み込みインスタンスに適用される。
  public request(): void { this.deferred?.request(); }

  // 入力の世代。画像が GPU へ公開されるたびに進む。
  public get generation(): number { return this.deferred?.generation ?? this.map.version; }

  // 平均気温 [K]。R は -40..40 °C を 0..1 で持つ。
  public temperatureK(direction: Vec3Node): FloatNode {
    return this.sample(direction).r.mul(80).add(233.15);
  }

  // 平年の雲量 0..1。
  public meanCloudiness(direction: Vec3Node): FloatNode {
    return this.sample(direction).g;
  }

  // 標高 [m]。
  public elevation(direction: Vec3Node): FloatNode {
    return this.sample(direction).b.mul(ELEVATION_SPAN);
  }

  // 陸らしさ 0..1(大洋で 0、大陸の内側で 1、海岸で渡る)。
  public landFraction(direction: Vec3Node): FloatNode {
    return smoothstep(0, LAND_ELEVATION, this.elevation(direction));
  }

  // 斜面の勾配(東向き・北向き成分)[m/m]。landHeight [m] は陸へ上乗せする高さ、surfaceRadius [m] は
  // この天体の半径。
  public slope(direction: Vec3Node, landHeight: number, surfaceRadius: number): Vec2Node {
    return climateSlope(this, direction, landHeight, surfaceRadius);
  }

  // 単位方向の気候値を CPU 側の数値で返す。画像がまだ届いていない、または CPU から
  // 画素を読めない形のときは null を返す。目盛りの復号は GPU 経路と同じ。
  public valuesAtCpu(direction: Vec3): ClimateValues | null {
    const pixels = this.pixels();
    if (pixels === null) return null;
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

  // 単位方向のテクセル(R 平均気温 / G 平年の雲量 / B 標高、それぞれ 0..1)。
  private sample(direction: Vec3Node): Vec4Node {
    return texture(this.map, equirectUvFromDirection(direction));
  }

  // 画像の画素列。読み出せる画像がまだ無いときは null。画像が差し替わる
  // (世代が進む)と次の呼び出しで取り直す。
  private pixels(): ClimatePixels | null {
    const image: unknown = this.map.image;
    if (this.cpuPixels !== null && this.cpuPixels.image === image) {
      return this.cpuPixels.pixels;
    }
    const pixels = pixelsFromImage(image);
    if (pixels === null) return null;
    this.cpuPixels = { image, pixels };
    return pixels;
  }

  // 保持しているテクスチャを解放する。
  public dispose(): void {
    if (this.deferred === null) this.map.dispose();
    else this.deferred.dispose();
  }
}

