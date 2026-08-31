// 天体の気候の事前テクスチャ(正距円筒 RGB8: R 平均気温 / G 平年の雲量 / B 標高)を読み、単位方向で
// 標本化する。雲より桁で低周波な、その天体固有の分布だけを持つ。
import * as THREE from 'three/webgpu';
import { texture, vec2 } from 'three/tsl';
import { R_EARTH } from '../../physics/solar-system/constants';
import { equirectUvFromDirection } from './field-projection';
import { eastAt, northAt } from './sphere-frame';
import type { FloatNode, Vec2Node, Vec3Node, Vec4Node } from '../tsl-types';

// テクスチャの目盛り。B は 0..8000 m を 0..1 で持つ。
const ELEVATION_SPAN = 8000;
// 標高の勾配を取る中心差分の刻み [rad]。テクスチャの texel(2π/512)より大きく、山脈の幅より小さい。
const SLOPE_STEP = 0.02;
// その刻みが地表で張る長さ [m]。勾配を角あたりから長さあたりへ直すのに要る。
const SLOPE_STEP_METERS = SLOPE_STEP * 2 * R_EARTH;

export class ClimateMap {
  // url の PNG を読み終えてから器を返す。
  public static async load(url: string): Promise<ClimateMap> {
    const map = await new THREE.TextureLoader().loadAsync(url);
    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.ClampToEdgeWrapping;
    map.flipY = false;
    map.generateMipmaps = false;
    map.minFilter = THREE.LinearFilter;
    map.magFilter = THREE.LinearFilter;
    map.colorSpace = THREE.NoColorSpace;
    return new ClimateMap(map);
  }

  private constructor(private readonly map: THREE.Texture) {}

  // 平年の雲量 0..1。
  public meanCloudiness(direction: Vec3Node): FloatNode {
    return this.sample(direction).g;
  }

  // 標高 [m]。
  public elevation(direction: Vec3Node): FloatNode {
    return this.sample(direction).b.mul(ELEVATION_SPAN);
  }

  // 標高の勾配(東向き・北向き成分)[m/m]。
  public slope(direction: Vec3Node): Vec2Node {
    const east = eastAt(direction).mul(SLOPE_STEP);
    const north = northAt(direction).mul(SLOPE_STEP);
    return vec2(
      this.elevation(direction.add(east)).sub(this.elevation(direction.sub(east))).div(SLOPE_STEP_METERS),
      this.elevation(direction.add(north)).sub(this.elevation(direction.sub(north))).div(SLOPE_STEP_METERS),
    );
  }

  // 単位方向のテクセル(R 平均気温 / G 平年の雲量 / B 標高、それぞれ 0..1)。
  private sample(direction: Vec3Node): Vec4Node {
    return texture(this.map, equirectUvFromDirection(direction));
  }

  // 保持しているテクスチャを解放する。
  public dispose(): void {
    this.map.dispose();
  }
}
