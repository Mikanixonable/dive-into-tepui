// 天体の気候の事前テクスチャ(正距円筒 RGB8: R 平均気温 / G 平年の雲量 / B 標高)を読み、単位方向で
// 標本化する。雲より桁で低周波な、その天体固有の分布だけを持つ。
import * as THREE from 'three/webgpu';
import { smoothstep, texture, vec2 } from 'three/tsl';
import { R_EARTH } from '../../game/celestial/solar-system/constants';
import { DeferredTexture } from '../deferred-texture';
import { equirectUvFromDirection } from './field-projection';
import { eastAt, northAt } from './sphere-frame';
import type { FloatNode, Vec2Node, Vec3Node, Vec4Node } from '../tsl-types';

export const CLIMATE_TEMPERATURE_MIN_K = 180;
export const CLIMATE_TEMPERATURE_MAX_K = 330;
export const CLIMATE_CLOUD_MIN = 0;
export const CLIMATE_CLOUD_MAX = 1;
export const CLIMATE_ELEVATION_MIN_M = -1000;
export const CLIMATE_ELEVATION_MAX_M = 9000;
export const CLIMATE_LAND_MIN = 0;
export const CLIMATE_LAND_MAX = 1;

// テクスチャの目盛り。B は 0..8000 m を 0..1 で持つ。
const ELEVATION_SPAN = 8000;
// 陸らしさが 1 に届く標高 [m]。**標高は海で 0、ぼかしの幅で海岸から立ち上がる**ので、低い値で
// 切れば陸と、その近くの海が読める。海抜の低い平野が海の側へ寄るが、板と粒を分けるのに要る
// のは大陸と大洋の区別なので足りる。
const LAND_ELEVATION = 100;
// 標高の勾配を取る中心差分の刻み [rad]。テクスチャの texel(2π/512)より大きく、山脈の幅より小さい。
const SLOPE_STEP = 0.02;
// その刻みが地表で張る長さ [m]。勾配を角あたりから長さあたりへ直すのに要る。
const SLOPE_STEP_METERS = SLOPE_STEP * 2 * R_EARTH;

export interface ClimateMapLike {
  readonly generation: number;
  temperatureK(direction: Vec3Node): FloatNode;
  meanCloudiness(direction: Vec3Node): FloatNode;
  elevation(direction: Vec3Node): FloatNode;
  landFraction(direction: Vec3Node): FloatNode;
  slope(direction: Vec3Node, landHeight: number): Vec2Node;
  request(): void;
  dispose(): void;
}

// 気候入力はデータ値をそのまま線形補間するため、色変換と mipmap を持たせない。
// MonthlyClimateMap もこの設定を使い、単月と月別でサンプルの境界を揃える。
export function configureClimateTexture(map: THREE.Texture): THREE.Texture {
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;
  map.flipY = false;
  map.generateMipmaps = false;
  map.minFilter = THREE.LinearFilter;
  map.magFilter = THREE.LinearFilter;
  map.colorSpace = THREE.NoColorSpace;
  return map;
}

export class ClimateMap implements ClimateMapLike {
  // url の PNG を読み終えてから器を返す。
  public static async load(url: string): Promise<ClimateMap> {
    const map = await new THREE.TextureLoader().loadAsync(url);
    return new ClimateMap(ClimateMap.configure(map), null);
  }

  // URL を保持したまま、既存の遅延テクスチャ経路で後から画像を公開する器を返す。
  public static fromDeferredUrl(url: string): ClimateMap {
    const deferred = new DeferredTexture(url, THREE.NoColorSpace);
    return new ClimateMap(ClimateMap.configure(deferred.texture), deferred);
  }

  private constructor(
    private readonly map: THREE.Texture,
    private readonly deferred: DeferredTexture | null,
  ) {}

  // 気候テクスチャを正距円筒の気候データとして読む設定を共通化する。
  private static configure(map: THREE.Texture): THREE.Texture {
    return configureClimateTexture(map);
  }

  // 遅延版だけ画像取得を開始する。ロード済み版では何もしない。
  public request(): void { this.deferred?.request(); }

  // 画像がGPUへ公開された回数。静的に読み込んだ地図ではtexture.versionを使う。
  // 雲場のキャッシュは表示時刻だけでなくこの入力世代もキーへ含める。
  public get generation(): number { return this.deferred?.generation ?? this.map.version; }

  // 旧 RGB8 入力の R は -40..40 °C を 0..1 で持つ。既存の雲生成では未使用だが、
  // 月別入力と同じ ClimateMapLike 境界へそろえるため Kelvin へ戻す。
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

  // 斜面の勾配(東向き・北向き成分)[m/m]。landHeight [m] は陸へ上乗せする高さで、海と陸の
  // 比熱の差で海岸へ吹き込む風が持ち上げられる分を、人工の斜面として代用する。
  public slope(direction: Vec3Node, landHeight: number): Vec2Node {
    const east = eastAt(direction).mul(SLOPE_STEP);
    const north = northAt(direction).mul(SLOPE_STEP);
    const height = (d: Vec3Node): FloatNode => this.elevation(d).add(this.landFraction(d).mul(landHeight));
    return vec2(
      height(direction.add(east)).sub(height(direction.sub(east))).div(SLOPE_STEP_METERS),
      height(direction.add(north)).sub(height(direction.sub(north))).div(SLOPE_STEP_METERS),
    );
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
