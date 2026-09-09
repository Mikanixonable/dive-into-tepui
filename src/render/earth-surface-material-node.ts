import * as THREE from 'three/webgpu';

export type EarthSurfaceMaterialTextureKind = 'pageTable' | 'color' | 'terrain';

export interface EarthSurfaceMaterialTextureSettings {
  readonly minFilter: typeof THREE.NearestFilter | typeof THREE.LinearFilter;
  readonly magFilter: typeof THREE.NearestFilter | typeof THREE.LinearFilter;
  readonly colorSpace: THREE.ColorSpace;
  readonly generateMipmaps: false;
}

export interface EarthSurfaceMaterialCapabilities {
  readonly useBaseFallback: boolean;
}

const TEXTURE_SETTINGS: Record<EarthSurfaceMaterialTextureKind, EarthSurfaceMaterialTextureSettings> = {
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

export function configureEarthSurfaceTexture<T extends THREE.Texture>(
  texture: T,
  kind: EarthSurfaceMaterialTextureKind,
): T {
  const settings = TEXTURE_SETTINGS[kind];
  texture.minFilter = settings.minFilter;
  texture.magFilter = settings.magFilter;
  texture.colorSpace = settings.colorSpace;
  texture.generateMipmaps = settings.generateMipmaps;
  texture.needsUpdate = true;
  return texture;
}

export function earthSurfaceMaterialCapabilities(unsupported: boolean): EarthSurfaceMaterialCapabilities {
  return { useBaseFallback: unsupported };
}
