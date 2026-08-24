// 天体表面のメッシュ。艦艇と同じライトプリパスの受け手として立ち、陰影・遮蔽・逆二乗の減衰は
// すべてパイプラインが与える — このモジュールが持つのはアルベドと球のジオメトリだけ。
import * as THREE from 'three/webgpu';
import { markLitOpaque } from './pipeline/lit-layer';
import type { Albedo } from './celestial-albedo';
import { SphereLodLevel } from './screen-lod';

// 球の開始方位 [rad]。正距円筒図法のテクスチャは経度 0 を u=0.5 へ置くので、その経線が
// モデルの本初子午線(+Z)へ来る向きから分割を始める。
const PRIME_MERIDIAN_PHI = -Math.PI / 2;

// 分割段ごとの単位球ジオメトリを、その段を使う全天体で共有する。
const sharedLodGeometries = new Map<SphereLodLevel, THREE.BufferGeometry>();
function unitSphereGeometry(level: SphereLodLevel): THREE.BufferGeometry {
  let geometry = sharedLodGeometries.get(level);
  if (geometry === undefined) {
    geometry = new THREE.SphereGeometry(
      1, level.widthSegments, level.heightSegments, PRIME_MERIDIAN_PHI);
    sharedLodGeometries.set(level, geometry);
  }
  return geometry;
}

export class CelestialSurface {
  // mesh は半径 1 の球で、表示側が位置・スケール・自転姿勢を毎フレーム与える。
  readonly mesh: THREE.Mesh;
  private readonly texture: THREE.Texture | null;

  // tint は map(あれば)へ掛かるアルベド。天体表面は粗い誘電体として扱う。
  private constructor(level: SphereLodLevel, tint: THREE.Color, map: THREE.Texture | null) {
    this.texture = map;
    const material = new THREE.MeshStandardMaterial({
      color: tint, map: map ?? undefined, roughness: 1, metalness: 0,
    });
    this.mesh = new THREE.Mesh(unitSphereGeometry(level), material);
    markLitOpaque(this.mesh);
  }

  // 実写テクスチャを貼った球面。albedoScale はテクスチャの明るさをその天体のアルベドへ
  // 合わせる倍率(render/celestial-textures.ts)。
  static textured(textureUrl: string, albedoScale: number, level: SphereLodLevel): CelestialSurface {
    const map = new THREE.TextureLoader().load(textureUrl);
    map.colorSpace = THREE.SRGBColorSpace;
    const tint = new THREE.Color(albedoScale, albedoScale, albedoScale);
    return new CelestialSurface(level, tint, map);
  }

  // テクスチャを持たない天体の単色球面。albedo は線形 RGB の拡散アルベド
  // (render/celestial-albedo.ts)で、sRGB の見た目色ではない。
  static solid(albedo: Albedo, level: SphereLodLevel): CelestialSurface {
    const tint = new THREE.Color().setRGB(albedo[0], albedo[1], albedo[2], THREE.LinearSRGBColorSpace);
    return new CelestialSurface(level, tint, null);
  }

  // mesh を親から外し、いま実際に描かれているマテリアルとテクスチャを解放する。テクスチャは
  // マテリアル側から連鎖解放されないので個別に dispose する。
  dispose(): void {
    this.mesh.removeFromParent();
    (this.mesh.material as THREE.Material).dispose();
    this.texture?.dispose();
  }
}
