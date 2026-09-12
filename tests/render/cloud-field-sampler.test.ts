import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { vec2, vec3 } from 'three/tsl';
import { test } from '../harness';
import { CloudFieldSampler } from '../../src/render/cloud/cloud-field-sampler';

export function register(): void {
  test('cloud field sampler: projection UV function is injected and used', () => {
    let calls = 0;
    const sampler = new CloudFieldSampler(new THREE.Texture(), () => {
      calls += 1;
      return vec2(0.25, 0.75);
    });

    sampler.sampleCloud(vec3(0, 1, 0));
    assert.equal(calls, 1);
  });
}
