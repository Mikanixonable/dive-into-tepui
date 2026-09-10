import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { vec4 } from 'three/tsl';
import { BakedField, maxMipLevelOf } from '../../src/render/cloud/baked-field';
import { EquirectProjection } from '../../src/render/cloud/field-projection';
import { CLOUD_GPU_MEASUREMENTS, GPU_PASS_LABELS } from '../../src/render/gpu-timings';
import { test } from '../harness';

export function register(): void {
  test('cloud mip: 生成RenderTargetはGPU自動mipの最大LODを寸法から持つ', () => {
    assert.equal(maxMipLevelOf(1, 1), 0);
    assert.equal(maxMipLevelOf(1024, 512), 10);

    const field = new BakedField(
      'testCloud', THREE.RGBAFormat, new EquirectProjection(8), 1,
      () => vec4(0, 0, 0, 1),
    );
    assert.equal(field.texture.generateMipmaps, true);
    assert.equal(field.texture.minFilter, THREE.LinearMipmapLinearFilter);
    assert.equal(field.texture.magFilter, THREE.LinearFilter);
    field.dispose();
  });

  test('cloud gpu timing: 雲の計測範囲と既存パスへのフォールバックが固定される', () => {
    assert.equal(GPU_PASS_LABELS[CLOUD_GPU_MEASUREMENTS.bake.pass], '雲ベイク');
    assert.equal(GPU_PASS_LABELS[CLOUD_GPU_MEASUREMENTS.atmosphere.pass], '雲大気');
    assert.equal(GPU_PASS_LABELS[CLOUD_GPU_MEASUREMENTS.shadow.pass], '雲影');
    assert.equal(CLOUD_GPU_MEASUREMENTS.surface.scope, 'gbuffer aggregate');
  });
}
