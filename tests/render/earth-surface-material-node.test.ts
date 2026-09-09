import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import {
  configureEarthSurfaceTexture,
  earthSurfaceMaterialCapabilities,
} from '../../src/render/earth-surface-material-node';

export function register(): void {
  test('earth surface material: texture settings are fixed by kind', () => {
    const pageTable = new THREE.Texture();
    const color = new THREE.Texture();
    const terrain = new THREE.Texture();

    assert.equal(configureEarthSurfaceTexture(pageTable, 'pageTable'), pageTable);
    assert.equal(configureEarthSurfaceTexture(color, 'color'), color);
    assert.equal(configureEarthSurfaceTexture(terrain, 'terrain'), terrain);

    assert.equal(pageTable.minFilter, THREE.NearestFilter);
    assert.equal(pageTable.magFilter, THREE.NearestFilter);
    assert.equal(pageTable.colorSpace, THREE.NoColorSpace);
    assert.equal(pageTable.generateMipmaps, false);
    assert.equal(color.minFilter, THREE.LinearFilter);
    assert.equal(color.magFilter, THREE.LinearFilter);
    assert.equal(color.colorSpace, THREE.SRGBColorSpace);
    assert.equal(color.generateMipmaps, false);
    assert.equal(terrain.minFilter, THREE.LinearFilter);
    assert.equal(terrain.magFilter, THREE.LinearFilter);
    assert.equal(terrain.colorSpace, THREE.NoColorSpace);
    assert.equal(terrain.generateMipmaps, false);
  });

  test('earth surface material: unsupported capability selects base fallback', () => {
    assert.deepEqual(earthSurfaceMaterialCapabilities(true), { useBaseFallback: true });
    assert.deepEqual(earthSurfaceMaterialCapabilities(false), { useBaseFallback: false });
  });
}
