import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { vec4 } from 'three/tsl';
import { BakedField, maxMipLevelOf } from '../../src/render/cloud/baked-field';
import { EquirectProjection } from '../../src/render/cloud/field-projection';
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
}
