// 天体表面のメッシュと、その昼夜の陰影。天体は光源を共有せず、自分の位置から見た恒星方向を
// uniform で受け取って自分だけで陰影を計算する。
import * as THREE from 'three/webgpu';
import { clamp, dot, float, normalWorld, texture as textureNode, uniform, uv, vec3 } from 'three/tsl';
import { SPHERE_LOD_LADDER, SphereLodLevel } from './screen-lod';
import type { Vec3Node } from './tsl-types';

// 夜側の明るさ(0 で真っ暗)。惑星光・星明かりを表す最低限の底上げ。
export const NIGHT_AMBIENT = 0.04;

// 分割数の組が SPHERE_LOD_LADDER のいずれかの段と一致する呼び出しだけ、その段の単位球
// ジオメトリを全呼び出し元(=全天体)で共有する。一致しない組(既存のジオメトリを
// 個別に書き換える呼び出しなど)は共有すると他の利用元を壊すため、専用に1つ作る。
const sharedLodGeometries = new Map<SphereLodLevel, THREE.BufferGeometry>();
function unitSphereGeometry(widthSegments: number, heightSegments: number): { geometry: THREE.BufferGeometry; shared: boolean } {
  const level = SPHERE_LOD_LADDER.find((l) => l.widthSegments === widthSegments && l.heightSegments === heightSegments);
  if (level === undefined) return { geometry: new THREE.SphereGeometry(1, widthSegments, heightSegments), shared: false };
  let geo = sharedLodGeometries.get(level);
  if (geo === undefined) {
    geo = new THREE.SphereGeometry(1, widthSegments, heightSegments);
    sharedLodGeometries.set(level, geo);
  }
  return { geometry: geo, shared: true };
}
export class CelestialSurface {
  private readonly sunDirNode = uniform(new THREE.Vector3(1, 0, 0));

  // mesh は半径 1 の球で、表示側が位置・スケール・自転姿勢を毎フレーム与える。
  readonly mesh: THREE.Mesh;
  // false なら mesh.geometry は SPHERE_LOD_LADDER 段の共有ジオメトリで、dispose では触らない。
  private readonly ownsGeometry: boolean;
  private readonly texture: THREE.Texture | null;
  private readonly material: THREE.MeshBasicNodeMaterial;

  // albedo は面の色を返すノード。これに昼夜の陰影を掛けたものが最終色になる。
  private constructor(geometry: THREE.BufferGeometry, ownsGeometry: boolean, albedo: Vec3Node, texture: THREE.Texture | null) {
    this.ownsGeometry = ownsGeometry;
    this.texture = texture;
    this.material = new THREE.MeshBasicNodeMaterial();
    const lambert = clamp(dot(normalWorld, this.sunDirNode), 0, 1);
    this.material.colorNode = albedo.mul(float(NIGHT_AMBIENT).add(lambert.mul(1 - NIGHT_AMBIENT)));
    this.mesh = new THREE.Mesh(geometry, this.material);
  }

  // 実写テクスチャを貼った球面。
  static textured(textureUrl: string, widthSegments: number, heightSegments: number): CelestialSurface {
    const map = new THREE.TextureLoader().load(textureUrl);
    map.colorSpace = THREE.SRGBColorSpace;
    const { geometry, shared } = unitSphereGeometry(widthSegments, heightSegments);
    return new CelestialSurface(geometry, !shared, textureNode(map, uv()).rgb, map);
  }

  // テクスチャを持たない天体の単色球面。
  static solid(color: number, widthSegments: number, heightSegments: number): CelestialSurface {
    const c = new THREE.Color(color);
    const { geometry, shared } = unitSphereGeometry(widthSegments, heightSegments);
    return new CelestialSurface(geometry, !shared, vec3(c.r, c.g, c.b), null);
  }

  // この天体の真の ECI 位置から見た恒星方向(単位ベクトル)を与える。
  setSunDirection(dir: THREE.Vector3): void {
    this.sunDirNode.value.copy(dir);
  }
  // mesh を親から外し、現行マテリアルとテクスチャを解放する。テクスチャは
  // material.dispose() から連鎖解放されない(TSL のノードグラフに埋め込まれているだけ)ため、
  // ここで個別に dispose する。
  dispose(): void {
    this.mesh.removeFromParent();
    this.material.dispose();
    if (this.ownsGeometry) this.mesh.geometry.dispose();
    this.texture?.dispose();
  }
}
