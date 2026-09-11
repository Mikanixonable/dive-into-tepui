// 天体の気候入力の契約。気候を単位方向で答える面と、その値域、斜面の勾配、気候テクスチャの読み方を持つ。
// 気候は雲より桁で低周波な、その天体固有の分布である。
import * as THREE from 'three/webgpu';
import { vec2 } from 'three/tsl';
import { eastAt, northAt } from './sphere-frame';
import type { FloatNode, Vec2Node, Vec3Node } from '../tsl-types';

// 月別の気候入力の RGBA 各チャンネル 0..1 が写す値域。気温 [K]、雲量、標高 [m]、陸地被覆率。
export const CLIMATE_TEMPERATURE_MIN_K = 180;
export const CLIMATE_TEMPERATURE_MAX_K = 330;
export const CLIMATE_CLOUD_MIN = 0;
export const CLIMATE_CLOUD_MAX = 1;
export const CLIMATE_ELEVATION_MIN_M = -1000;
export const CLIMATE_ELEVATION_MAX_M = 9000;
export const CLIMATE_LAND_MIN = 0;
export const CLIMATE_LAND_MAX = 1;

// 標高の勾配を取る中心差分の刻み [rad]。テクスチャの texel(2π/512)より大きく、山脈の幅より小さい。
const SLOPE_STEP = 0.02;

// 天体の気候を単位方向で答える入力。generation は画像が GPU へ公開されるたびに進む世代。
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

// 気候テクスチャを、データ値のまま線形補間で読める設定にして返す。
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
