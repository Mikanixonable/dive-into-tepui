// 同じテクスチャを指すテクスチャノードの結びの共有を固定する。three.js はシェーダを組む時点で uuid の同じ
// テクスチャを指すノードを 1 つの結びへ合わせるので、起動時に値を結ぶ前にシェーダを組むと、あとから別々の
// 枚を結んでも全部のノードが 1 枚を読む(雲場の 2 枚補間・風・環境が実機で効かなくなった原因)。
// シェーダへ入るのは sample() が返す基底の複製なので、複製の結びで確かめる。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { texture, vec2 } from 'three/tsl';
import { distinctTextureNode } from '../../src/render/distinct-texture-node';
import { test } from '../harness';

function emptyTexture(): THREE.DataTexture {
  return new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
}

// builder は使われない引数。
const NO_BUILDER = undefined as never;
const hashOf = (node: THREE.TextureNode): string => node.getUniformHash(NO_BUILDER);

export function register(): void {
  test('texture node: 同じテクスチャを指すノードの複製は、既定では結びの hash が同じになる', () => {
    const shared = emptyTexture();
    assert.equal(hashOf(texture(shared).sample(vec2(0, 0))), hashOf(texture(shared).sample(vec2(0, 0))));
  });

  test('distinct texture node: 同じテクスチャを指しても、複製の結びは基底ごとに別々で、値を差し替えても変わらない', () => {
    const shared = emptyTexture();
    const first = distinctTextureNode(shared);
    const second = distinctTextureNode(shared);
    assert.notEqual(hashOf(first.sample(vec2(0, 0))), hashOf(second.sample(vec2(0, 0))));
    // 同じ基底から作った複製は、読む場所が違っても 1 つの結びを使う。
    assert.equal(hashOf(first.sample(vec2(0, 0))), hashOf(first.sample(vec2(0.5, 0.5))));
    first.value = emptyTexture();
    second.value = emptyTexture();
    assert.notEqual(hashOf(first.sample(vec2(0, 0))), hashOf(second.sample(vec2(0, 0))));
  });
}
