// 天体を光源として焼くときの見た目を定める語彙。
import type * as THREE from 'three/webgpu';
import type { Albedo } from '../../celestial-albedo';

// 天体 1 体ぶんの見た目。すべて描画座標系の値。
export interface PlanetLightAppearance {
  // 全球の正距円筒テクスチャ。持たない天体と、画像がまだ届いていない天体は null。
  readonly map: THREE.Texture | null;
  // map の色へ掛けて、平均をボンドアルベドへ合わせる倍率。
  readonly albedoScale: number;
  // map を持たない天体の一様な拡散アルベド(線形 RGB)。
  readonly albedo: Albedo;
  // その天体の場所の太陽放射照度に、天体の食を掛けたもの。
  readonly sunIrradiance: number;
  // 天体中心から恒星への単位方向。
  readonly starDirection: THREE.Vector3;
  // 描画座標のベクトルを天体固定の向きへ回す行列。
  readonly bodyFromWorld: THREE.Matrix4;
}
