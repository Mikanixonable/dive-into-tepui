import * as assert from 'node:assert/strict';
import { DEBUG_TARGETS } from '../../src/render/pipeline/debug-target';
import { test } from '../harness';

export function register(): void {
  test('debug target: 通常だけ先頭例外で、以後は生成順に並ぶ', () => {
    const ids = DEBUG_TARGETS.map(([id]) => id);
    assert.strictEqual(ids[0], 'off');
    assert.strictEqual(new Set(ids).size, ids.length);
    const before = (earlier: typeof ids[number], later: typeof ids[number]): void => {
      assert.ok(ids.indexOf(earlier) < ids.indexOf(later), `${earlier} must precede ${later}`);
    };
    before('shadow-map', 'normal');
    before('normal', 'shadow');
    before('depth', 'motion');
    before('motion', 'shadow');
    before('shadow', 'planet-light');
    before('planet-light', 'bounce-source');
    // 走査の帯 → 代表の縮小列 → 段ごとの帯の縮小(段 m は帯 m〜4) → 粗い段からの拡大と合流 → 描画バッファの
    // 解像度への拡大。
    const chain = [
      'band-0', 'band-1', 'band-2', 'band-3', 'band-4',
      'representative-0', 'representative-1', 'representative-2', 'representative-3', 'representative-4',
      'reduced-1-band-1', 'reduced-1-band-2', 'reduced-1-band-3', 'reduced-1-band-4',
      'reduced-2-band-2', 'reduced-2-band-3', 'reduced-2-band-4',
      'reduced-3-band-3', 'reduced-3-band-4',
      'reduced-4-band-4',
      'merged-3', 'merged-share-3', 'merged-2', 'merged-share-2',
      'merged-1', 'merged-share-1', 'merged-0', 'merged-share-0',
    ] as const;
    before('bounce-source', chain[0]);
    for (const [index, id] of chain.slice(1).entries()) before(chain[index]!, id);
    before(chain[chain.length - 1]!, 'correction');
    before('correction', 'diffuse');
    before('diffuse', 'direct-specular');
    before('direct-specular', 'far-specular');
    before('far-specular', 'material');
    before('material', 'reflection-source');
    before('reflection-source', 'reflection-depth');
    before('reflection-depth', 'raw-reflection-weight');
    before('raw-reflection-weight', 'raw-reflection-distance');
    before('raw-reflection-distance', 'raw-reflection');
    before('raw-reflection', 'denoised-reflection-weight');
    before('denoised-reflection-weight', 'denoised-reflection-distance');
    before('denoised-reflection-distance', 'denoised-reflection');
    before('denoised-reflection', 'reflection-denoise-level');
    before('reflection-denoise-level', 'atmosphere');
    before('atmosphere', 'lens');
    assert.ok(!ids.includes('occlusion' as typeof ids[number]));
    assert.ok(!ids.includes('indirect' as typeof ids[number]));
  });
}
