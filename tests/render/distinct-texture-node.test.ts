// 同じテクスチャを指すテクスチャノードの結びの共有を固定する。three.js はシェーダを組む時点で uuid の同じ
// テクスチャを指すノードを 1 つの結びへ合わせるので、起動時に値を結ぶ前にシェーダを組むと、あとから別々の
// 枚を結んでも全部のノードが 1 枚を読む(雲場の 2 枚補間・風・環境が実機で効かなくなった原因)。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { texture } from 'three/tsl';
import { distinctTextureNode } from '../../src/render/distinct-texture-node';
import { test } from '../harness';

function emptyTexture(): THREE.DataTexture {
  return new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
}

// builder は使われない引数。
const NO_BUILDER = undefined as never;

export function register(): void {
  test('texture node: 同じテクスチャを指すノードは、既定では結びの hash が同じになる', () => {
    const shared = emptyTexture();
    assert.equal(texture(shared).getUniformHash(NO_BUILDER), texture(shared).getUniformHash(NO_BUILDER));
  });

  test('distinct texture node: 同じテクスチャを指しても結びが別々で、値を差し替えても別々のまま', () => {
    const shared = emptyTexture();
    const first = distinctTextureNode(shared);
    const second = distinctTextureNode(shared);
    assert.notEqual(first.getUniformHash(NO_BUILDER), second.getUniformHash(NO_BUILDER));
    first.value = emptyTexture();
    second.value = emptyTexture();
    assert.notEqual(first.getUniformHash(NO_BUILDER), second.getUniformHash(NO_BUILDER));
    assert.equal(first.getUniformHash(NO_BUILDER), first.uuid);
  });
}
