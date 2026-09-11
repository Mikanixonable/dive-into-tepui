import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import {
  configureEarthSurfaceTexture,
  earthSurfaceDetailLodNode,
  earthSurfaceTileUvNode,
  earthSurfaceMaterialNodes,
  earthSurfaceMaterialCapabilities,
} from '../../src/render/earth-surface-material-node';
import { float, uniform, vec2, vec3 } from 'three/tsl';
import { containsShaderNode, evaluateShaderNode } from './tsl-node-evaluator';

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
    assert.equal(pageTable.image, null);
    assert.equal(pageTable.version, 0);
    const data = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    assert.equal(data.version, 0);
    configureEarthSurfaceTexture(data, 'color');
    assert.equal(data.version, 1);
  });

  test('earth surface material: unsupported capability selects base fallback', () => {
    assert.deepEqual(earthSurfaceMaterialCapabilities(true), { useBaseFallback: true });
    assert.deepEqual(earthSurfaceMaterialCapabilities(false), { useBaseFallback: false });
  });

  test('earth surface material: tile Vは各LOD行を走査し、全球南端を最終画素へ置く', () => {
    for (const z of [1, 2, 7]) {
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
    assert.ok(containsShaderNode(earthSurfaceDetailLodNode(float(255)),
      (node) => node.type === 'MathNode' && node.method === 'min'));
  });

  test('earth surface material: array/page table nodeはbase層とbody固定法線を持つ', () => {
    const color = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1);
    const terrain = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1);
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
    assert.ok(containsShaderNode(nodes.normalNode, (node) => node.type === 'MathNode' && node.method === 'normalize'));
  });
}
