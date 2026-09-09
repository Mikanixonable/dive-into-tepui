import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { vec2, vec3 } from 'three/tsl';
import { test } from '../harness';
import { CloudFieldSampler } from '../../src/render/cloud/cloud-field-sampler';
import { EllipsoidEquirectProjection } from '../../src/render/cloud/field-projection';

export function register(): void {
  test('cloud field sampler: projection UV function is injected and used', () => {
    let calls = 0;
    const sampler = new CloudFieldSampler(new THREE.Texture(), () => {
      calls += 1;
      return vec2(0.25, 0.75);
    });

    sampler.sample(vec3(0, 1, 0));
    assert.equal(calls, 1);
  });

  test('cloud field sampler: ellipsoid equirect projection exposes the shared UV contract', () => {
    const projection = new EllipsoidEquirectProjection(512, vec3(6378137, 6356752, 6378137));
    const direction = projection.directionAt(vec2(0.63, 0.2));
    const uv = projection.uvAt(direction);
    assert.equal(projection.width, 1024);
    assert.equal(projection.height, 512);
    assert.ok(direction !== undefined);
    assert.ok(uv !== undefined);
  });
}
