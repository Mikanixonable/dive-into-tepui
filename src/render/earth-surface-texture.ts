// 地表のbase・詳細配列・ページ表で共有するThree.jsテクスチャ設定。
import * as THREE from 'three/webgpu';

export type EarthSurfaceTextureKind = 'pageTable' | 'color' | 'terrain';

export interface EarthSurfaceTextureSettings {
  readonly minFilter: typeof THREE.NearestFilter | typeof THREE.LinearFilter;
  readonly magFilter: typeof THREE.NearestFilter | typeof THREE.LinearFilter;
  readonly colorSpace: THREE.ColorSpace;
  readonly generateMipmaps: false;
}

const TEXTURE_SETTINGS: Record<EarthSurfaceTextureKind, EarthSurfaceTextureSettings> = {
  pageTable: {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    colorSpace: THREE.NoColorSpace,
    generateMipmaps: false,
  },
  color: {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    colorSpace: THREE.SRGBColorSpace,
    generateMipmaps: false,
  },
  terrain: {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    colorSpace: THREE.NoColorSpace,
    generateMipmaps: false,
  },
};

// 配列用途ごとの補間・色空間をテクスチャへ適用する。
export function configureEarthSurfaceTexture<T extends THREE.Texture>(
  texture: T,
  kind: EarthSurfaceTextureKind,
): T {
  // 配列用途ごとの補間・色空間を統一し、CPU画像の上下反転を無効にする。
  const settings = TEXTURE_SETTINGS[kind];
  texture.minFilter = settings.minFilter;
  texture.magFilter = settings.magFilter;
  texture.colorSpace = settings.colorSpace;
  texture.generateMipmaps = settings.generateMipmaps;
  texture.flipY = false;
  texture.unpackAlignment = 1;
  if (texture.image !== null && texture.image !== undefined) texture.needsUpdate = true;
  return texture;
}
