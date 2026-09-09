// 天体表面のメッシュ。分割段ラダーの各段ぶんの球を1枚のマテリアルで束ね、見かけ直径に応じて
// 1段だけを見せる。艦艇と同じライトプリパスの受け手として立ち、陰影・影・逆二乗の減衰は
// すべてパイプラインが与える。**画像の取得は addTo まで遅らせる。**
import * as THREE from 'three/webgpu';
import { texture as textureNode, asin, atan, clamp, uv, vec2 } from 'three/tsl';
import { DeferredTexture } from './deferred-texture';
import { markLitOpaque } from './pipeline/lit-layer';
import { rec709Luminance, scaledToBondAlbedo, type Albedo } from './celestial-albedo';
import { sphereLodLevel, SPHERE_LOD_LADDER, SphereLodLevel } from './screen-lod';
import type { CelestialTexture } from './celestial-textures';
import type { Vec2Node, Vec3Node } from './tsl-types';
import type { RenderStyle } from './render-style';

// 球の開始方位 [rad]。正距円筒図法のテクスチャは経度 0 を u=0.5 へ置くので、その経線が
// モデルの本初子午線(+Z)へ来る向きから分割を始める。
const PRIME_MERIDIAN_PHI = -Math.PI / 2;

// 天体固定の単位方向を、球メッシュが持つ uv へ写す(分割の逆写像)。u は 0..1 へ畳まないので、
// この uv でテクスチャを読む側は経度方向を巻いておく。
export function sphereMeshUv(direction: Vec3Node): Vec2Node {
  const longitude = atan(direction.z, direction.x.negate());
  return vec2(
    longitude.sub(PRIME_MERIDIAN_PHI).div(2 * Math.PI),
    asin(clamp(direction.y, -1, 1)).div(Math.PI).add(0.5),
  );
}

// 分割段ごとの単位球ジオメトリを、その段を使う全天体で共有する。
const sharedLodGeometries = new Map<SphereLodLevel, THREE.BufferGeometry>();

// その段の半径 1 の球。同じ段には同じ実体を返すので、呼び手はこれを書き換えない。
export function unitSphereGeometry(level: SphereLodLevel): THREE.BufferGeometry {
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

// 天体の位置・姿勢・形状を確定した後に、表面固有の同期へ渡す値。
export interface CelestialSurfaceFrame {
  readonly camera: THREE.Camera;
  readonly bodyToView: THREE.Matrix4;
  readonly axes: THREE.Vector3;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly frame: number;
  readonly timeMs: number;
  readonly style: RenderStyle;
}

let surfaceViewport = { width: 1, height: 1 };

// RenderPipelineが毎フレーム確定したdrawing bufferをsurface同期へ共有する。
// windowのCSS寸法はdevicePixelRatioや解像度設定と一致しないため、LOD判定には使わない。
export function setCelestialSurfaceViewport(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new RangeError('Invalid celestial surface viewport');
  }
  surfaceViewport = { width, height };
}

export function celestialSurfaceViewport(): { readonly width: number; readonly height: number } {
  return surfaceViewport;
}

const UNIT_SCALE = new THREE.Vector3(1, 1, 1);

// 天体の位置・姿勢だけをbody-to-viewへ組み込む。表面の非一様スケールは法線変換を
// 壊すため、axesとして別に渡す。
export function createCelestialSurfaceFrame(
  camera: THREE.Camera, position: THREE.Vector3, quaternion: THREE.Quaternion,
  axes: THREE.Vector3, frame: number, timeMs: number, style: RenderStyle,
  viewport = surfaceViewport,
): CelestialSurfaceFrame {
  const bodyToWorld = new THREE.Matrix4().compose(position, quaternion, UNIT_SCALE);
  return {
    camera,
    bodyToView: camera.matrixWorldInverse.clone().multiply(bodyToWorld),
    axes: axes.clone(),
    viewport: { width: viewport.width, height: viewport.height },
    frame,
    timeMs,
    style,
  };
}

export interface CelestialSurfaceLike {
  readonly photometry: SurfacePhotometry | null;
  readonly textureUrl: string | null;
  addTo(parent: THREE.Object3D): void;
  syncLod(apparentDiameterPx: number): void;
  syncFrame(frame: CelestialSurfaceFrame): void;
  hide(): void;
  dispose(): void;
}

export interface CelestialSurfaceMaterialAttachment {
  readonly material: THREE.Material;
  readonly deferred: readonly DeferredTexture[];
  readonly textures?: readonly THREE.Texture[];
  readonly onDispose?: () => void;
}

// 実写テクスチャの測光。倍率を掛ける前の平均色を、その天体のボンドアルベドへ合わせる。
function photometryOf(texture: CelestialTexture): SurfacePhotometry {
  return {
    bondAlbedo: texture.bondAlbedo,
    lightSourceAlbedo: scaledToBondAlbedo(texture.averageHue, texture.bondAlbedo),
  };
}

export class CelestialSurface implements CelestialSurfaceLike {
  // 段ごとの半径 1 の球。表示側が親の位置・スケール・自転姿勢を毎フレーム与える。
  private readonly meshes: ReadonlyMap<SphereLodLevel, THREE.Mesh>;
  private activeLevel: SphereLodLevel | null = null;
  private readonly fallbackMaterial: THREE.Material;
  private readonly fallbackDeferred: readonly DeferredTexture[];
  private readonly fallbackTextures: readonly THREE.Texture[];
  private usingFallbackMaterial = true;
  private materialOnDispose: (() => void) | undefined;

  // material と deferred のテクスチャは解放までこの表面が持つ。photometry / textureUrl は静的事実。
  private constructor(
    private material: THREE.Material,
    private deferred: readonly DeferredTexture[],
    private ownedTextures: readonly THREE.Texture[],
    public readonly photometry: SurfacePhotometry | null,
    public readonly textureUrl: string | null,
  ) {
    this.fallbackMaterial = material;
    this.fallbackDeferred = deferred;
    this.fallbackTextures = ownedTextures;
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
  // smoothnessUrl を渡すと、地表の滑らかさ(1 − 粗さ)を赤チャンネルに持つ地表と同じ正距円筒の
  // テクスチャが、粗さを場所ごとに決める。
  public static textured(
    texture: CelestialTexture, smoothnessUrl: string | null = null,
  ): CelestialSurface {
    const map = new DeferredTexture(texture.url, THREE.SRGBColorSpace);
    const smoothnessMap = smoothnessUrl === null
      ? null : new DeferredTexture(smoothnessUrl, THREE.NoColorSpace);
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
    material.colorNode = textureNode(map.texture, uv()).mul(texture.albedoScale);
    // **粗さではなく滑らかさで持つ** — 画像が届くまでテクスチャは 0 を返すので、0 が拡散側へ
    // 来る向きでなければ、届くまでの数フレームだけ地表が鏡面になる。
    if (smoothnessMap !== null) {
      material.roughnessNode = textureNode(smoothnessMap.texture, uv()).r.oneMinus();
    }
    return new CelestialSurface(
      material, smoothnessMap === null ? [map] : [map, smoothnessMap],
      [],
      photometryOf(texture), texture.url);
  }

  // テクスチャを持たない天体の単色球面。albedo は線形 RGB の拡散アルベド
  // (render/celestial-albedo.ts)で、sRGB の見た目色ではない。
  public static solid(albedo: Albedo): CelestialSurface {
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(albedo[0], albedo[1], albedo[2], THREE.LinearSRGBColorSpace),
      roughness: 1, metalness: 0,
    });
    return new CelestialSurface(
      material, [], [], { bondAlbedo: rec709Luminance(albedo), lightSourceAlbedo: albedo }, null);
  }

  // 全段のメッシュを parent の下へ置く。
  public addTo(parent: THREE.Object3D): void {
    for (const mesh of this.meshes.values()) parent.add(mesh);
  }

  // EarthSurfaceの詳細材質を既存の球LOD群へ差し替える。初期fallbackは再接続時に戻せるよう
  // surfaceが保持し、以前の詳細材質とその資源は直ちに解放する。
  public replaceMaterial(attachment: CelestialSurfaceMaterialAttachment): void {
    if (!this.usingFallbackMaterial) {
      this.materialOnDispose?.();
      this.material.dispose();
      for (const deferred of this.deferred) deferred.dispose();
      for (const texture of this.ownedTextures) texture.dispose();
    }
    this.material = attachment.material;
    this.deferred = attachment.deferred;
    this.ownedTextures = attachment.textures ?? [];
    this.materialOnDispose = attachment.onDispose;
    this.usingFallbackMaterial = false;
    for (const mesh of this.meshes.values()) mesh.material = attachment.material;
  }

  // GPU材質を外したとき、破棄済みのGPUテクスチャを読む代わりに初期fallbackへ戻す。
  public restoreFallbackMaterial(): void {
    if (this.usingFallbackMaterial) return;
    this.materialOnDispose?.();
    this.material.dispose();
    for (const deferred of this.deferred) deferred.dispose();
    for (const texture of this.ownedTextures) texture.dispose();
    this.material = this.fallbackMaterial;
    this.deferred = this.fallbackDeferred;
    this.ownedTextures = this.fallbackTextures;
    this.materialOnDispose = undefined;
    this.usingFallbackMaterial = true;
    for (const mesh of this.meshes.values()) mesh.material = this.material;
  }

  // 見かけ直径 [px] から分割段を選び、その段のメッシュだけを見せる。テクスチャ画像の取得も
  // ここで始める — 球として描く価値が出るまで、遠くの天体の画像を取りに行かないため。
  public syncLod(apparentDiameterPx: number): void {
    for (const deferred of this.deferred) deferred.request();
    const level = sphereLodLevel(apparentDiameterPx);
    if (level === this.activeLevel) return;
    this.activeLevel = level;
    for (const [meshLevel, mesh] of this.meshes) mesh.visible = meshLevel === level;
  }

  // 地球固有の表面同期を差し込む共通境界。静的な球面では何もしない。
  public syncFrame(_frame: CelestialSurfaceFrame): void {}

  // 全段のメッシュを隠す。次の syncLod で段を選び直す。
  public hide(): void {
    this.activeLevel = null;
    for (const mesh of this.meshes.values()) mesh.visible = false;
  }

  // 全段のメッシュを親から外し、マテリアルとテクスチャを解放する。テクスチャは
  // マテリアル側から連鎖解放されないので個別に dispose する。
  public dispose(): void {
    for (const mesh of this.meshes.values()) mesh.removeFromParent();
    this.materialOnDispose?.();
    this.materialOnDispose = undefined;
    if (this.usingFallbackMaterial) {
      this.fallbackMaterial.dispose();
      for (const deferred of this.fallbackDeferred) deferred.dispose();
      for (const texture of this.fallbackTextures) texture.dispose();
      return;
    }
    this.material.dispose();
    for (const deferred of this.deferred) deferred.dispose();
    for (const texture of this.ownedTextures) texture.dispose();
    this.fallbackMaterial.dispose();
    for (const deferred of this.fallbackDeferred) deferred.dispose();
    for (const texture of this.fallbackTextures) texture.dispose();
  }
}
