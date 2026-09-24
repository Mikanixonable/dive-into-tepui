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
    before('shadow', 'planet-light');
    before('planet-light', 'bounce-source');
    before('bounce-source', 'raw-correction');
    before('raw-correction', 'correction');
    before('correction', 'diffuse');
    before('diffuse', 'material');
    before('material', 'atmosphere');
    before('atmosphere', 'lens');
    assert.ok(!ids.includes('occlusion' as typeof ids[number]));
    assert.ok(!ids.includes('indirect' as typeof ids[number]));
  });
}
