// 天体の気候入力の契約と、平年の気候テクスチャ(正距円筒 RGB8: R 平均気温 / G 平年の雲量 / B 標高)を
// 読むその実装。気候は雲より桁で低周波な、その天体固有の分布である。
import * as THREE from 'three/webgpu';
import { smoothstep, texture, vec2 } from 'three/tsl';
import { DeferredTexture } from '../deferred-texture';
import { equirectUvFromDirection } from './field-projection';
import { eastAt, northAt } from './sphere-frame';
import type { FloatNode, Vec2Node, Vec3Node, Vec4Node } from '../tsl-types';

// テクスチャの目盛り。B は 0..8000 m を 0..1 で持つ。
const ELEVATION_SPAN = 8000;
// 陸らしさが 1 に届く標高 [m]。**標高は海で 0、ぼかしの幅で海岸から立ち上がる**ので、低い値で
// 切れば陸と、その近くの海が読める。海抜の低い平野が海の側へ寄るが、板と粒を分けるのに要る
// のは大陸と大洋の区別なので足りる。
const LAND_ELEVATION = 100;
// 標高の勾配を取る中心差分の刻み [rad]。テクスチャの texel(2π/512)より大きく、山脈の幅より小さい。
const SLOPE_STEP = 0.02;

// 天体の気候を単位方向で答える入力。generation は入力(読む画像か、その選択)が変わるたびに進む世代。
export interface ClimateMap {
  readonly generation: number;
  temperatureK(direction: Vec3Node): FloatNode;
  meanCloudiness(direction: Vec3Node): FloatNode;
  elevation(direction: Vec3Node): FloatNode;
  landFraction(direction: Vec3Node): FloatNode;
  slope(direction: Vec3Node, landHeight: number, surfaceRadius: number): Vec2Node;
  request(): void;
  dispose(): void;
}

// climate の標高と陸らしさから、斜面の勾配(東向き・北向き成分)[m/m] を中心差分で引く。
// landHeight [m] は陸へ上乗せする高さで、海と陸の比熱の差で海岸へ吹き込む風が持ち上げられる分を、
// 人工の斜面として代用する。surfaceRadius [m] はこの天体の半径で、勾配を角あたりから長さあたりへ
// 直すのに要る。
export function climateSlope(
  climate: ClimateMap, direction: Vec3Node, landHeight: number, surfaceRadius: number,
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
export class AnnualClimateMap implements ClimateMap {
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

  private constructor(
    private readonly map: THREE.Texture,
    private readonly deferred: DeferredTexture | null,
  ) {}

  // 画像の取得を始める。fromDeferredUrl で作った器で効く。
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

  // 単位方向のテクセル(R 平均気温 / G 平年の雲量 / B 標高、それぞれ 0..1)。
  private sample(direction: Vec3Node): Vec4Node {
    return texture(this.map, equirectUvFromDirection(direction));
  }

  // 保持しているテクスチャを解放する。
  public dispose(): void {
    if (this.deferred === null) this.map.dispose();
    else this.deferred.dispose();
  }
}
