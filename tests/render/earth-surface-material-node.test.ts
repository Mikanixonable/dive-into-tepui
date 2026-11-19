import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import {
  earthSurfaceDetailLodNode,
  earthSurfaceTileUvNode,
  decodeEarthSurfaceNormalNode,
  earthSurfaceMaterialCapabilities,
} from '../../src/render/earth-surface-material-node';
import { configureEarthSurfaceTexture } from '../../src/render/earth-surface-texture';
import { EARTH_TILE_MAX_Z, EARTH_TILE_MIN_Z } from '../../src/render/earth-surface-tile-key';
import { float, vec2, vec3 } from 'three/tsl';
import { evaluateShaderNode } from './tsl-node-evaluator';

function tileUvValue(u: number, v: number, z: number): number[] {
  return evaluateShaderNode(earthSurfaceTileUvNode(vec2(u, v), float(z))) as number[];
}

function near(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
}

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
    assert.equal(pageTable.flipY, false);
    assert.equal(color.minFilter, THREE.LinearFilter);
    assert.equal(color.magFilter, THREE.LinearFilter);
    assert.equal(color.colorSpace, THREE.SRGBColorSpace);
    assert.equal(color.generateMipmaps, false);
    assert.equal(color.flipY, false);
    assert.equal(terrain.minFilter, THREE.LinearFilter);
    assert.equal(terrain.magFilter, THREE.LinearFilter);
    assert.equal(terrain.colorSpace, THREE.NoColorSpace);
    assert.equal(terrain.generateMipmaps, false);
    assert.equal(terrain.flipY, false);
  });

  test('earth surface material: unsupported capability selects base fallback', () => {
    assert.deepEqual(earthSurfaceMaterialCapabilities(true), { useBaseFallback: true });
    assert.deepEqual(earthSurfaceMaterialCapabilities(false), { useBaseFallback: false });
  });

  test('earth surface material: tile Vは各LOD行を走査し、全球南端を最終画素へ置く', () => {
    for (let z = EARTH_TILE_MIN_Z; z <= EARTH_TILE_MAX_Z; z++) {
      const rows = 2 ** z;
      const toTextureUv = (local: number): number => (2 + 0.5 + 256 * local) / 260;
      const expected = (v: number): number => toTextureUv(v === 1 ? 1 : v * rows - Math.floor(v * rows));
      for (const row of [1, Math.floor(rows / 2), rows - 1]) {
        for (const side of [-1, 1]) {
          const v = (row + side * 0.125) / rows;
          near(tileUvValue(0.37, v, z)[1]!, expected(v));
        }
      }
      near(tileUvValue(0.37, 1, z)[1]!, toTextureUv(1));
      near(tileUvValue(-0.1, 0.37, z)[0]!, toTextureUv(((-0.1 * rows * 2) % 1 + 1) % 1));
      near(tileUvValue(1.1, 0.37, z)[0]!, toTextureUv(((1.1 * rows * 2) % 1 + 1) % 1));
    }
    assert.equal(evaluateShaderNode(earthSurfaceDetailLodNode(float(255))), EARTH_TILE_MAX_Z);
  });

  test('earth surface material: encoded normal is decoded to a unit body normal', () => {
    const decoded = evaluateShaderNode(decodeEarthSurfaceNormalNode(vec3(1, 0.5, 0.5))) as number[];
    near(decoded[0]!, 1);
    near(decoded[1]!, 0);
    near(decoded[2]!, 0);
  });
}
