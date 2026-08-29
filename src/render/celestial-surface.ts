// 天体表面のメッシュ。分割段ラダーの各段ぶんの球を1つのアルベドで束ね、見かけ直径に応じて
// 1段だけを見せる。艦艇と同じライトプリパスの受け手として立ち、陰影・遮蔽・逆二乗の減衰は
// すべてパイプラインが与える。
// **画像の取得は addTo まで遅らせる** — 取得は DOM を要するので、構築だけなら DOM の無い
// 環境でも通る。テクスチャの実体は構築時からあり、画像が届いた時点で絵が入れ替わる。
import * as THREE from 'three/webgpu';
import { texture as textureNode, mix, uniform, uv, vec2, vec3 } from 'three/tsl';
import { markLitOpaque } from './pipeline/lit-layer';
import { rec709Luminance, scaledToBondAlbedo, type Albedo } from './celestial-albedo';
import type { CelestialTexture } from './celestial-textures';
import type { FloatUniform } from './tsl-types';
import { sphereLodLevel, SPHERE_LOD_LADDER, SphereLodLevel } from './screen-lod';

// 球の開始方位 [rad]。正距円筒図法のテクスチャは経度 0 を u=0.5 へ置くので、その経線が
// モデルの本初子午線(+Z)へ来る向きから分割を始める。
const PRIME_MERIDIAN_PHI = -Math.PI / 2;

// 雲を地表アルベドへ合成するときの、雲影の落とし方。雲を太陽方向へ SHADOW_OFFSET_U だけ
// ずらして参照し、そこを最大 SHADOW_DEPTH まで暗くする(SHADOW_STRENGTH は影の濃さ)。
// いずれも合成手法の定数で、天体ごとの物理量ではない。
const CLOUD_SHADOW_OFFSET_U = 0.001;
const CLOUD_SHADOW_DEPTH = 0.2;
const CLOUD_SHADOW_STRENGTH = 0.8;

// 実写テクスチャの異方性フィルタ段数。斜めから見た地表の縞立ちを抑える。
const SURFACE_ANISOTROPY = 16;

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

// 画像の取得を待っているテクスチャと、その取得元。
type DeferredTexture = { readonly texture: THREE.Texture; readonly url: string };

// 画像を持たないテクスチャを先に立てる。マテリアルもシェーダグラフもこの実体を参照するので、
// 画像が後から届いても差し替えは要らない。
function deferredTexture(url: string, colorSpace: string): DeferredTexture {
  const texture = new THREE.Texture();
  texture.colorSpace = colorSpace;
  texture.anisotropy = SURFACE_ANISOTROPY;
  return { texture, url };
}

// 表面の測光値。bondAlbedo は輝点の明るさを引くスカラ、lightSourceAlbedo はこの天体を
// 光源として扱うときの色つきアルベド(Rec.709 輝度がボンドアルベドに一致する線形 RGB)。
export type SurfacePhotometry = {
  readonly bondAlbedo: number;
  readonly lightSourceAlbedo: Albedo;
};

function photometryOf(texture: CelestialTexture): SurfacePhotometry {
  return {
    bondAlbedo: texture.bondAlbedo,
    lightSourceAlbedo: scaledToBondAlbedo(texture.averageHue, texture.bondAlbedo),
  };
}

export class CelestialSurface {
  // 段ごとの半径 1 の球。表示側が親の位置・スケール・自転姿勢を毎フレーム与える。
  private readonly meshes: ReadonlyMap<SphereLodLevel, THREE.Mesh>;
  private activeLevel: SphereLodLevel | null = null;
  private imagesRequested = false;

  // material と deferred のテクスチャは解放までこの表面が持つ。photometry / textureUrl は
  // 静的事実。cloudAmount は雲を合成する表面だけが持つ雲量の口。
  private constructor(
    private readonly material: THREE.Material,
    private readonly deferred: readonly DeferredTexture[],
    private readonly cloudAmount: FloatUniform | null,
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
    const map = deferredTexture(texture.url, THREE.SRGBColorSpace);
    const scale = texture.albedoScale;
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(scale, scale, scale), map: map.texture, roughness: 1, metalness: 0,
    });
    return new CelestialSurface(material, [map], null, photometryOf(texture), texture.url);
  }

  // 地表テクスチャへ雲と雲影を焼き込んだ球面。cloudsUrl は雲の被覆率を赤チャンネルに持つ
  // テクスチャ。texture の測光は合成後のアルベドとして測ったものを渡す。
  static clouded(texture: CelestialTexture, cloudsUrl: string): CelestialSurface {
    const surfaceMap = deferredTexture(texture.url, THREE.SRGBColorSpace);
    const cloudsMap = deferredTexture(cloudsUrl, THREE.NoColorSpace);
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
    const cloudAmount = uniform(1);
    const surfaceSample = textureNode(surfaceMap.texture, uv());
    // 雲そのものと、雲を太陽方向へずらして参照した地表側の影。
    const cloudAlpha = textureNode(cloudsMap.texture, uv()).r.mul(cloudAmount);
    const shadowAlpha = textureNode(cloudsMap.texture, uv().add(vec2(CLOUD_SHADOW_OFFSET_U, 0.0))).r.mul(cloudAmount);
    const shaded = mix(surfaceSample, surfaceSample.mul(CLOUD_SHADOW_DEPTH), shadowAlpha.mul(CLOUD_SHADOW_STRENGTH));
    material.colorNode = mix(shaded, vec3(1, 1, 1), cloudAlpha).mul(texture.albedoScale);
    return new CelestialSurface(
      material, [surfaceMap, cloudsMap], cloudAmount, photometryOf(texture), texture.url);
  }

  // テクスチャを持たない天体の単色球面。albedo は線形 RGB の拡散アルベド
  // (render/celestial-albedo.ts)で、sRGB の見た目色ではない。
  static solid(albedo: Albedo): CelestialSurface {
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(albedo[0], albedo[1], albedo[2], THREE.LinearSRGBColorSpace),
      roughness: 1, metalness: 0,
    });
    return new CelestialSurface(
      material, [], null, { bondAlbedo: rec709Luminance(albedo), lightSourceAlbedo: albedo }, null);
  }

  // 全段のメッシュを parent の下へ置き、テクスチャ画像の取得を始める。
  addTo(parent: THREE.Object3D): void {
    this.requestImages();
    for (const mesh of this.meshes.values()) parent.add(mesh);
  }

  // 地表へ焼き込む雲と、雲が地表へ落とす影の濃さ [0..1]。雲を合成しない表面では効かない。
  setCloudAmount(amount: number): void {
    if (this.cloudAmount !== null) this.cloudAmount.value = amount;
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
    for (const { texture } of this.deferred) texture.dispose();
  }

  // 待機中のテクスチャへ画像を流し込む。取得は非同期なので、届くまでは絵が乗らない。
  private requestImages(): void {
    if (this.imagesRequested) return;
    this.imagesRequested = true;
    for (const { texture, url } of this.deferred) {
      new THREE.ImageLoader().load(url, (image) => {
        texture.image = image;
        texture.needsUpdate = true;
      });
    }
  }
}
