// 天体表面へ差し込む材質と、その材質が所有する遅延・実テクスチャの寿命を束ねる。
import * as THREE from 'three/webgpu';
import { DeferredTexture } from '../deferred-texture';

export interface CelestialSurfaceMaterialAttachment {
  readonly material: THREE.Material;
  readonly deferred: readonly DeferredTexture[];
  readonly textures?: readonly THREE.Texture[];
  readonly onDispose?: () => void;
}

export interface CelestialSurfaceMaterialHost {
  replaceMaterial(attachment: CelestialSurfaceMaterialAttachment): void;
  restoreFallbackMaterial?(): void;
}

// 材質を差し込めなかった場合も含め、attachmentの持ち物を一度に解放する。
export function disposeCelestialSurfaceMaterialAttachment(
  attachment: CelestialSurfaceMaterialAttachment,
): void {
  attachment.onDispose?.();
  attachment.material.dispose();
  for (const deferred of attachment.deferred) deferred.dispose();
  for (const texture of attachment.textures ?? []) texture.dispose();
}
