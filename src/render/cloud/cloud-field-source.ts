// 雲テクスチャを供給する境界。projection はテクスチャが値を持つ座標系を表し、
// 読み手が別の投影へ写すときの基準になる。テクスチャの所有権は供給元が管理する。
import type * as THREE from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import type { GpuTimingSink } from '../gpu-timings';
import type { FieldProjection } from '../field-projection';
import type { CloudStateBinding } from './cloud-state';

export interface CloudFieldSource {
  readonly basisTexture: THREE.Texture;
  readonly shapeTexture: THREE.Texture;
  readonly projection: FieldProjection;
  readonly state: CloudStateBinding;
  readonly generation: number;
  prepare(renderer: WebGPURenderer, displayTime: number, gpu?: GpuTimingSink | null): void;
  dispose(): void;
}
