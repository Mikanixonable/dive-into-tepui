// 天体表面のメッシュ。分割段ラダーの各段ぶんの球を1枚のマテリアルで束ね、見かけ直径に応じて
// 1段を見せる。ライトプリパスの受け手として描かれる。テクスチャ画像は最初の syncLod で取りに行く。
import * as THREE from 'three/webgpu';
import { texture as textureNode, uv } from 'three/tsl';
import { DeferredTexture } from '../deferred-texture';
import { markLitOpaque } from '../pipeline/lit-layer';
import { rec709Luminance, scaledToBondAlbedo, type Albedo } from '../celestial-albedo';
import { sphereLodLevel, SPHERE_LOD_LADDER, SphereLodLevel } from './screen-lod';
import {
  disposeCelestialSurfaceMaterialAttachment,
  type CelestialSurfaceMaterialAttachment,
} from './celestial-surface-material';
import type { CelestialTexture } from '../celestial-textures';
import type { RenderStyle } from '../render-style';

// 球の開始方位 [rad]。正距円筒図法のテクスチャは経度 0 を u=0.5 へ置くので、その経線が
// モデルの本初子午線(+Z)へ来る向きから分割を始める。
const PRIME_MERIDIAN_PHI = -Math.PI / 2;

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
export interface SurfacePhotometry {
  readonly bondAlbedo: number;
  readonly lightSourceAlbedo: Albedo;
}

export type CelestialSurfaceStatus = 'loading' | 'ready' | 'error' | 'fallback';

// 表面の読み込み状態の診断値。
export interface CelestialSurfaceDiagnostics {
  readonly status: CelestialSurfaceStatus;
  readonly reason: string | null;
  readonly usesDetailedMaterial: boolean;
  readonly residentMaxZ: number | null;
}

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

// 表面の同期が使う描画先の大きさ [px]。
let surfaceViewport = { width: 1, height: 1 };

// 表面の同期が使う描画先の大きさ [px] を設定する。確定した drawing buffer の寸法を渡す — window
// の CSS 寸法は devicePixelRatio や解像度設定でずれる。正の有限値でなければ RangeError。
export function setCelestialSurfaceViewport(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new RangeError('Invalid celestial surface viewport');
  }
  surfaceViewport = { width, height };
}

// 最後に設定した描画先の大きさ [px]。未設定なら 1×1。
export function celestialSurfaceViewport(): { readonly width: number; readonly height: number } {
  return surfaceViewport;
}

const UNIT_SCALE = new THREE.Vector3(1, 1, 1);

// 天体の位置・姿勢から body-to-view を組んだフレーム値を作る。扁平のスケールは法線変換を
// 壊すので行列へ入れず、axes として別に渡す。
export function createCelestialSurfaceFrame(
  camera: THREE.Camera, position: THREE.Vector3, quaternion: THREE.Quaternion,
  axes: THREE.Vector3, frame: number, timeMs: number, style: RenderStyle,
  viewport = surfaceViewport,
): CelestialSurfaceFrame {
  // 渡された行列・ベクトルは複製し、このフレームの値として固定する。
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

// 天体表面の表示が満たす面。
export interface CelestialSurfaceLike {
  readonly photometry: SurfacePhotometry | null;
  readonly textureUrl: string | null;
  readonly diagnostics: CelestialSurfaceDiagnostics | null;
  addTo(parent: THREE.Object3D): void;
  syncLod(apparentDiameterPx: number): void;
  syncFrame(frame: CelestialSurfaceFrame): void;
  hide(): void;
  dispose(): void;
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
  private readonly fallbackAttachment: CelestialSurfaceMaterialAttachment;
  private activeAttachment: CelestialSurfaceMaterialAttachment;

  // material と deferred のテクスチャは解放までこの表面が持つ。photometry / textureUrl は静的事実。
  private constructor(
    fallbackAttachment: CelestialSurfaceMaterialAttachment,
    public readonly photometry: SurfacePhotometry | null,
    public readonly textureUrl: string | null,
    public readonly baseColorTexture: THREE.Texture | null,
  ) {
    this.fallbackAttachment = fallbackAttachment;
    this.activeAttachment = fallbackAttachment;
    const meshes = new Map<SphereLodLevel, THREE.Mesh>();
    // 段ごとにメッシュを持つ — WebGPU では mesh.geometry の差し替えが効かない。
    for (const level of SPHERE_LOD_LADDER) {
      const mesh = new THREE.Mesh(unitSphereGeometry(level), fallbackAttachment.material);
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
      {
        material,
        deferred: smoothnessMap === null ? [map] : [map, smoothnessMap],
      },
      photometryOf(texture), texture.url, map.texture);
  }

  // テクスチャを持たない天体の単色球面。albedo は線形 RGB の拡散アルベド。
  public static solid(albedo: Albedo): CelestialSurface {
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(albedo[0], albedo[1], albedo[2], THREE.LinearSRGBColorSpace),
      roughness: 1, metalness: 0,
    });
    return new CelestialSurface(
      { material, deferred: [] }, { bondAlbedo: rec709Luminance(albedo), lightSourceAlbedo: albedo }, null, null);
  }

  public get diagnostics(): CelestialSurfaceDiagnostics | null { return null; }

  // 全段のメッシュを parent の下へ置く。
  public addTo(parent: THREE.Object3D): void {
    for (const mesh of this.meshes.values()) parent.add(mesh);
  }

  // 全段のメッシュの材質を詳細材質へ差し替え、attachment の資源を解放まで持つ。初期の材質は
  // restoreFallbackMaterial のために残す。
  public replaceMaterial(attachment: CelestialSurfaceMaterialAttachment): void {
    // 前に差し込んだ詳細材質とその資源を解放する。
    if (this.activeAttachment !== this.fallbackAttachment) {
      disposeCelestialSurfaceMaterialAttachment(this.activeAttachment);
    }
    // 新しい材質を全段へ付け替える。
    this.activeAttachment = attachment;
    for (const mesh of this.meshes.values()) mesh.material = attachment.material;
  }

  // 差し込んだ詳細材質とその資源を解放し、初期の材質へ戻す。詳細材質が無ければ何もしない。
  public restoreFallbackMaterial(): void {
    if (this.activeAttachment === this.fallbackAttachment) return;
    // 詳細材質とその資源を解放する。
    disposeCelestialSurfaceMaterialAttachment(this.activeAttachment);
    // 初期の材質を全段へ戻す。
    this.activeAttachment = this.fallbackAttachment;
    for (const mesh of this.meshes.values()) mesh.material = this.fallbackAttachment.material;
  }

  // 見かけ直径 [px] から分割段を選び、その段のメッシュを見せる。テクスチャ画像の取得もここで始める。
  public syncLod(apparentDiameterPx: number): void {
    for (const deferred of this.activeAttachment.deferred) deferred.request();
    const level = sphereLodLevel(apparentDiameterPx);
    if (level === this.activeLevel) return;
    this.activeLevel = level;
    for (const [meshLevel, mesh] of this.meshes) mesh.visible = meshLevel === level;
  }

  // 位置・姿勢・形状が確定したフレーム値で表面を同期する。静的な球面では空。
  public syncFrame(_frame: CelestialSurfaceFrame): void {}

  // 全段のメッシュを隠す。次の syncLod で段を選び直す。
  public hide(): void {
    this.activeLevel = null;
    for (const mesh of this.meshes.values()) mesh.visible = false;
  }

  // 全段のメッシュを親から外し、マテリアルとテクスチャを解放する。テクスチャはマテリアルから
  // 連鎖解放されないので個別に解放する。
  public dispose(): void {
    for (const mesh of this.meshes.values()) mesh.removeFromParent();
    if (this.activeAttachment !== this.fallbackAttachment) {
      disposeCelestialSurfaceMaterialAttachment(this.activeAttachment);
    }
    disposeCelestialSurfaceMaterialAttachment(this.fallbackAttachment);
  }
}
