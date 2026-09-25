import * as assert from 'node:assert/strict';
import {
  cloudQualityPolicy,
  cloudTemporalCachePlan,
  cloudTemporalSampleTimes,
  type CloudTemporalCacheState,
} from '../../src/render/cloud/cloud-quality';
import { test } from '../harness';

export function register(): void {
  test('cloud quality: higher quality narrows temporal and spatial filtering', () => {
    const policies = [0, 1, 2, 3].map((level) => cloudQualityPolicy(level));
    for (let index = 1; index < policies.length; index += 1) {
      assert.ok(policies[index]!.temporalIntervalSeconds < policies[index - 1]!.temporalIntervalSeconds);
      assert.ok(policies[index]!.detailFootprintScale < policies[index - 1]!.detailFootprintScale);
    }
    assert.throws(() => cloudQualityPolicy(-1), RangeError);
    assert.throws(() => cloudQualityPolicy(4), RangeError);
  });

  test('cloud quality: temporal samples are deterministic across zero and negative time', () => {
    const positive = cloudTemporalSampleTimes(1_234, 2);
    const negative = cloudTemporalSampleTimes(-1_234, 2);
    assert.equal(positive.lowerTimeSeconds, 900);
    assert.equal(positive.upperTimeSeconds, 1_800);
    assert.equal(negative.lowerTimeSeconds, -1_800);
    assert.equal(negative.upperTimeSeconds, -900);
    assert.ok(positive.fraction >= 0 && positive.fraction < 1);
    assert.ok(negative.fraction >= 0 && negative.fraction < 1);
  });

  test('cloud quality: two-time cache reuses one slot for sequential motion', () => {
    let state: CloudTemporalCacheState = { timeA: null, timeB: null };
    const first = cloudTemporalCachePlan(1_000, 2, state);
    assert.equal(first.writes.length, 2);
    state = {
      timeA: first.writes.find((write) => write.slot === 'A')?.timeSeconds ?? null,
      timeB: first.writes.find((write) => write.slot === 'B')?.timeSeconds ?? null,
    };

    const next = cloudTemporalCachePlan(1_900, 2, state);
    assert.equal(next.writes.length, 1);
    assert.notEqual(next.lowerSlot, next.upperSlot);
    assert.ok(next.blendAtoB >= 0 && next.blendAtoB <= 1);
  });

  test('cloud quality: reverse and jump cache plans remain bounded to two writes', () => {
    const state: CloudTemporalCacheState = { timeA: 900, timeB: 1_800 };
    const reverse = cloudTemporalCachePlan(100, 2, state);
    assert.ok(reverse.writes.length <= 2);
    assert.notEqual(reverse.lowerSlot, reverse.upperSlot);

    const jump = cloudTemporalCachePlan(86_400, 2, state);
    assert.equal(jump.writes.length, 2);
    assert.notEqual(jump.lowerSlot, jump.upperSlot);
    assert.deepEqual(
      new Set(jump.writes.map((write) => write.timeSeconds)),
      new Set([jump.lowerTimeSeconds, jump.upperTimeSeconds]),
    );
  });

  test('cloud quality: exact temporal boundary still materializes two adjacent samples', () => {
    const plan = cloudTemporalCachePlan(3_600, 0, { timeA: 0, timeB: 3_600 });
    assert.equal(plan.lowerTimeSeconds, 3_600);
    assert.equal(plan.upperTimeSeconds, 7_200);
    assert.equal(plan.fraction, 0);
    assert.equal(plan.writes.length, 1);
    assert.notEqual(plan.lowerSlot, plan.upperSlot);
  });
}
