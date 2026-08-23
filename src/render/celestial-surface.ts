// 天体表面のメッシュ。艦艇と同じライトプリパスの受け手として立ち、陰影・遮蔽・逆二乗の減衰は
// すべてパイプラインが与える — このモジュールが持つのはアルベドと球のジオメトリだけ。
import * as THREE from 'three/webgpu';
import { markLitOpaque } from './pipeline/lit-layer';
import { SUN_IRRADIANCE_1AU } from './pipeline/sun-light';
import { SPHERE_LOD_LADDER, SphereLodLevel } from './screen-lod';

// 天体の直書き色・テクスチャから拡散アルベドへの換算。それらは「1 天文単位で照らされた
// 見え方」をそのまま置いた値なので、そこへ届く放射照度と Lambert の 1/π を戻す。本物の
// アルベドを持たせるまでの繋ぎで、色そのものが物理量になれば消える。
export const ALBEDO_FROM_LIT_COLOR = Math.PI / SUN_IRRADIANCE_1AU;

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

  // 実写テクスチャを貼った球面。
  static textured(textureUrl: string, widthSegments: number, heightSegments: number): CelestialSurface {
    const map = new THREE.TextureLoader().load(textureUrl);
    map.colorSpace = THREE.SRGBColorSpace;
    const { geometry, shared } = unitSphereGeometry(widthSegments, heightSegments);
    const tint = new THREE.Color(ALBEDO_FROM_LIT_COLOR, ALBEDO_FROM_LIT_COLOR, ALBEDO_FROM_LIT_COLOR);
    return new CelestialSurface(geometry, !shared, tint, map);
  }

  // テクスチャを持たない天体の単色球面。
  static solid(color: number, widthSegments: number, heightSegments: number): CelestialSurface {
    const { geometry, shared } = unitSphereGeometry(widthSegments, heightSegments);
    const tint = new THREE.Color(color).multiplyScalar(ALBEDO_FROM_LIT_COLOR);
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
