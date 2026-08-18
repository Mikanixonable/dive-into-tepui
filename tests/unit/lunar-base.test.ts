import * as assert from 'node:assert/strict';
import { test } from '../physics/harness';
import { assessLunarBase, assessLunarSite, baseSitePoint } from '../../src/game/vessel/lunar-base';
import { len } from '../../src/physics/vec3';

export function register(): void {
  test('lunar site assessment is deterministic and returns a surface point', () => {
    const site = assessLunarSite(-1.4, 0.3);
    assert.deepEqual(site, assessLunarSite(-1.4, 0.3));
    assert.ok(len(baseSitePoint(site)) > 1.7e6);
    assert.equal(assessLunarBase(site, 2, 100, 1).site.bodyId, 'moon');
  });
}
