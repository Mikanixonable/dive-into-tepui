import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import {
  configureEarthSurfaceTexture,
  earthSurfaceMaterialNodes,
  earthSurfaceMaterialCapabilities,
} from '../../src/render/earth-surface-material-node';
import { uniform, vec3 } from 'three/tsl';

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

  test('earth surface material: array/page table nodeはbase層とbody固定法線を持つ', () => {
    const color = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1);
    const terrain = new THREE.DataArrayTexture(new Uint16Array(4), 1, 1, 1);
    const pageTable = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    const baseColor = new THREE.Texture();
    const baseTerrain = new THREE.Texture();
    const nodes = earthSurfaceMaterialNodes(
      { pageTable, color, terrain, baseColor, baseTerrain },
      {
        bodyDirection: vec3(1, 0, 0),
        axes: vec3(2, 3, 4),
        geometricNormalView: vec3(0, 1, 0),
        bodyToView: uniform(new THREE.Matrix3()),
        schematic: uniform(false),
      },
    );
    assert.equal(nodes.colorNode.isNode, true);
    assert.equal(nodes.roughnessNode.isNode, true);
    assert.equal(nodes.normalNode.isNode, true);
  });
}
