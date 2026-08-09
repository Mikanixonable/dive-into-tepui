// 天体表面のメッシュと、その昼夜の陰影。天体は描画される位置が真の位置と一致しない
// (戦闘ビューは視距離を圧縮してカメラの近くへ置く)ため、シーンのライトで照らすと
// 昼夜境界が実際の太陽方向と合わない。そこで天体は光源を共有せず、自分の真の位置から見た
// 恒星方向を uniform で受け取り、自分だけで陰影を計算する。
import * as THREE from 'three/webgpu';
import { clamp, dot, float, normalWorld, texture as textureNode, uniform, uv, vec3 } from 'three/tsl';
import { Vec3 } from '../physics/vec3';

// 夜側の明るさ(0 で真っ暗)。惑星光・星明かりを表す最低限の底上げ。
export const NIGHT_AMBIENT = 0.04;

export class CelestialSurface {
  private readonly sunDirNode = uniform(new THREE.Vector3(1, 0, 0));

  // mesh は半径 1 の球で、表示側が位置・スケール・自転姿勢を毎フレーム与える。
  readonly mesh: THREE.Mesh;

  // albedo は面の色を返すノード。これに昼夜の陰影を掛けたものが最終色になる。
  private constructor(geometry: THREE.BufferGeometry, albedo: ReturnType<typeof vec3>) {
    const mat = new THREE.MeshBasicNodeMaterial();
    const lambert = clamp(dot(normalWorld, this.sunDirNode), 0, 1);
    mat.colorNode = albedo.mul(float(NIGHT_AMBIENT).add(lambert.mul(1 - NIGHT_AMBIENT)));
    this.mesh = new THREE.Mesh(geometry, mat as unknown as THREE.Material);
    this.mesh.frustumCulled = false;
  }

  // 実写テクスチャを貼った球面。
  static textured(textureUrl: string, widthSegments = 48, heightSegments = 24): CelestialSurface {
    const map = new THREE.TextureLoader().load(textureUrl);
    map.colorSpace = THREE.SRGBColorSpace;
    return new CelestialSurface(new THREE.SphereGeometry(1, widthSegments, heightSegments), textureNode(map, uv()));
  }

  // テクスチャを持たない天体の単色球面。
  static solid(color: number): CelestialSurface {
    const c = new THREE.Color(color);
    return new CelestialSurface(new THREE.SphereGeometry(1, 32, 16), vec3(c.r, c.g, c.b));
  }

  // この天体の真の ECI 位置から見た恒星方向(単位ベクトル)を与える。
  setSunDirection(dir: Vec3): void {
    this.sunDirNode.value.set(dir.x, dir.y, dir.z);
  }
}
