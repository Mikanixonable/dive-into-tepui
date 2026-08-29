// 天体表面のメッシュ。分割段ラダーの各段ぶんの球を1つのアルベドで束ね、見かけ直径に応じて
// 1段だけを見せる。艦艇と同じライトプリパスの受け手として立ち、陰影・遮蔽・逆二乗の減衰は
// すべてパイプラインが与える。
// **実写テクスチャの読み込みは addTo まで遅らせる** — 画像の取得は DOM を要するので、
// 構築だけなら DOM の無い環境でも通る。
import * as THREE from 'three/webgpu';
import { markLitOpaque } from './pipeline/lit-layer';
import { rec709Luminance, scaledToBondAlbedo, type Albedo } from './celestial-albedo';
import type { CelestialTexture } from './celestial-textures';
import { sphereLodLevel, SPHERE_LOD_LADDER, SphereLodLevel } from './screen-lod';

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

// 表面の測光値。bondAlbedo は輝点の明るさを引くスカラ、lightSourceAlbedo はこの天体を
// 光源として扱うときの色つきアルベド(Rec.709 輝度がボンドアルベドに一致する線形 RGB)。
export type SurfacePhotometry = {
  readonly bondAlbedo: number;
  readonly lightSourceAlbedo: Albedo;
};

export class CelestialSurface {
  // 段ごとの半径 1 の球。表示側が親の位置・スケール・自転姿勢を毎フレーム与える。
  private readonly meshes: ReadonlyMap<SphereLodLevel, THREE.Mesh>;
  private activeLevel: SphereLodLevel | null = null;
  // 読み込み済みの実写テクスチャ。addTo で読むまで null。
  private texture: THREE.Texture | null = null;

  // material と texture は解放までこの表面が持つ。photometry / textureUrl は静的事実で、
  // 自前のマテリアルを持ち込む表面(withMaterial)では null。texturedMaterial は読み込んだ
  // テクスチャを差す先で、textureUrl と同時に非 null になる。
  private constructor(
    private readonly material: THREE.Material,
    private readonly texturedMaterial: THREE.MeshStandardMaterial | null,
    readonly photometry: SurfacePhotometry | null,
    readonly textureUrl: string | null,
  ) {
    const meshes = new Map<SphereLodLevel, THREE.Mesh>();
    // 段ごとにメッシュを持つ — WebGPU では mesh.geometry の差し替えが効かない。
    for (const level of SPHERE_LOD_LADDER) {
      const mesh = new THREE.Mesh(unitSphereGeometry(level), material);
      mesh.visible = false;
      markLitOpaque(mesh);
      meshes.set(level, mesh);
    }
    this.meshes = meshes;
  }

  // 実写テクスチャを貼った球面。テクスチャの明るさはその天体のアルベドへ合わせる倍率で正す。
  static textured(texture: CelestialTexture): CelestialSurface {
    const scale = texture.albedoScale;
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(scale, scale, scale), roughness: 1, metalness: 0,
    });
    const photometry = {
      bondAlbedo: texture.bondAlbedo,
      lightSourceAlbedo: scaledToBondAlbedo(texture.averageHue, texture.bondAlbedo),
    };
    return new CelestialSurface(material, material, photometry, texture.url);
  }

  // テクスチャを持たない天体の単色球面。albedo は線形 RGB の拡散アルベド
  // (render/celestial-albedo.ts)で、sRGB の見た目色ではない。
  static solid(albedo: Albedo): CelestialSurface {
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(albedo[0], albedo[1], albedo[2], THREE.LinearSRGBColorSpace),
      roughness: 1, metalness: 0,
    });
    return new CelestialSurface(material, null, { bondAlbedo: rec709Luminance(albedo), lightSourceAlbedo: albedo }, null);
  }

  // マテリアルを自前で組む天体の球面。material の解放もこの表面が担う。
  static withMaterial(material: THREE.Material): CelestialSurface {
    return new CelestialSurface(material, null, null, null);
  }

  // 全段のメッシュを parent の下へ置き、実写テクスチャの読み込みを始める。
  addTo(parent: THREE.Object3D): void {
    this.loadTexture();
    for (const mesh of this.meshes.values()) parent.add(mesh);
  }

  // 実写テクスチャを読み込んでマテリアルへ差す。テクスチャを持たない表面では何も起きない。
  private loadTexture(): void {
    const material = this.texturedMaterial;
    if (material === null || this.textureUrl === null || this.texture !== null) return;
    const map = new THREE.TextureLoader().load(this.textureUrl);
    map.colorSpace = THREE.SRGBColorSpace;
    this.texture = map;
    material.map = map;
    material.needsUpdate = true;
  }

  // 見かけ直径 [px] から分割段を選び、その段のメッシュだけを見せる。
  syncLod(apparentDiameterPx: number): void {
    const level = sphereLodLevel(apparentDiameterPx);
    if (level === this.activeLevel) return;
    this.activeLevel = level;
    for (const [meshLevel, mesh] of this.meshes) mesh.visible = meshLevel === level;
  }

  // 全段のメッシュを隠す。次の syncLod で段を選び直す。
  hide(): void {
    this.activeLevel = null;
    for (const mesh of this.meshes.values()) mesh.visible = false;
  }

  // 全段のメッシュを親から外し、マテリアルとテクスチャを解放する。テクスチャは
  // マテリアル側から連鎖解放されないので個別に dispose する。
  dispose(): void {
    for (const mesh of this.meshes.values()) mesh.removeFromParent();
    this.material.dispose();
    this.texture?.dispose();
  }
}
