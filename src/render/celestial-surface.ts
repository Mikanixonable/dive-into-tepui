// 天体表面のメッシュ。艦艇と同じライトプリパスの受け手として立ち、陰影・遮蔽・逆二乗の減衰は
// すべてパイプラインが与える — このモジュールが持つのはアルベドと球のジオメトリだけ。
import * as THREE from 'three/webgpu';
import { markLitOpaque } from './pipeline/lit-layer';
import type { Albedo } from './celestial-albedo';
import { SPHERE_LOD_LADDER, SphereLodLevel } from './screen-lod';

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
  // mesh は半径 1 の球で、表示側が位置・スケール・自転姿勢を毎フレーム与える。
  readonly mesh: THREE.Mesh;
  // false なら mesh.geometry は SPHERE_LOD_LADDER 段の共有ジオメトリで、dispose では触らない。
  private readonly ownsGeometry: boolean;
  private readonly texture: THREE.Texture | null;

  // tint は map(あれば)へ掛かるアルベド。天体表面は粗い誘電体として扱う。
  private constructor(geometry: THREE.BufferGeometry, ownsGeometry: boolean, tint: THREE.Color, map: THREE.Texture | null) {
    this.ownsGeometry = ownsGeometry;
    this.texture = map;
    const material = new THREE.MeshStandardMaterial({
      color: tint, map: map ?? undefined, roughness: 1, metalness: 0,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    markLitOpaque(this.mesh);
  }

  // 実写テクスチャを貼った球面。albedoScale はテクスチャの明るさをその天体のアルベドへ
  // 合わせる倍率(render/celestial-textures.ts)。
  static textured(textureUrl: string, albedoScale: number, widthSegments: number, heightSegments: number): CelestialSurface {
    const map = new THREE.TextureLoader().load(textureUrl);
    map.colorSpace = THREE.SRGBColorSpace;
    const { geometry, shared } = unitSphereGeometry(widthSegments, heightSegments);
    const tint = new THREE.Color(albedoScale, albedoScale, albedoScale);
    return new CelestialSurface(geometry, !shared, tint, map);
  }

  // テクスチャを持たない天体の単色球面。albedo は線形 RGB の拡散アルベド
  // (render/celestial-albedo.ts)で、sRGB の見た目色ではない。
  static solid(albedo: Albedo, widthSegments: number, heightSegments: number): CelestialSurface {
    const { geometry, shared } = unitSphereGeometry(widthSegments, heightSegments);
    const tint = new THREE.Color().setRGB(albedo[0], albedo[1], albedo[2], THREE.LinearSRGBColorSpace);
    return new CelestialSurface(geometry, !shared, tint, null);
  }

  // mesh を親から外し、いま実際に描かれているマテリアルとテクスチャを解放する。テクスチャは
  // マテリアル側から連鎖解放されないので個別に dispose する。
  dispose(): void {
    this.mesh.removeFromParent();
    (this.mesh.material as THREE.Material).dispose();
    if (this.ownsGeometry) this.mesh.geometry.dispose();
    this.texture?.dispose();
  }
}
