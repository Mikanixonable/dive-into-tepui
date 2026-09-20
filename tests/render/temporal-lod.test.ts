// 雲の時間LODの回帰テスト。最大ワープでは個体追跡ではなく時間幅の平均化と更新上限を使う。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  EXTREME_MAX_BAKES_PER_REAL_SECOND, INTERMEDIATE_MAX_SIMULATION_SECONDS,
  NORMAL_MAX_SIMULATION_SECONDS, canBakeInWindow, temporalLodFor, targetSimulationTime,
} from '../../src/render/cloud/temporal-lod';
import { splitSimulationTime } from '../../src/render/cloud/weather-time';

const MAX_SIMULATION_SECONDS_PER_FRAME = 33554432 / 60;

export function register(): void {
  test('temporal-lod: normalは全ての連続性weightを保つ', () => {
    const profile = temporalLodFor(NORMAL_MAX_SIMULATION_SECONDS, 1 / 60);
    assert.equal(profile.mode, 'normal');
    assert.equal(profile.cellWeight, 1);
    assert.equal(profile.weatherObjectWeight, 1);
    assert.equal(profile.dailyCycleWeight, 1);
  });

  test('temporal-lod: intermediateはsynoptic優先へ連続に落とす', () => {
    const profile = temporalLodFor(INTERMEDIATE_MAX_SIMULATION_SECONDS + 1, 1 / 60);
    assert.equal(profile.mode, 'extreme');
    const intermediate = temporalLodFor(NORMAL_MAX_SIMULATION_SECONDS + 1, 1 / 60);
    assert.equal(intermediate.mode, 'intermediate');
    assert.ok(intermediate.cellWeight < 1);
    assert.ok(intermediate.weatherObjectWeight > profile.weatherObjectWeight);
  });

  test('temporal-lod: max warpは6日超/フレームでもextremeになり4回/秒を上限にする', () => {
    const profile = temporalLodFor(MAX_SIMULATION_SECONDS_PER_FRAME, 1 / 60);
    assert.equal(profile.mode, 'extreme');
    assert.equal(profile.maxBakesPerRealSecond, EXTREME_MAX_BAKES_PER_REAL_SECOND);
    assert.equal(profile.dailyCycleWeight, 0);
    assert.equal(canBakeInWindow(0, 0, EXTREME_MAX_BAKES_PER_REAL_SECOND, profile), false);
  });

  test('temporal-lod: intermediateはtarget anchorへ直接到達する', () => {
    const seconds = 3 * 60 * 60 + 17;
    const profile = temporalLodFor(3600, 1 / 60);
    const target = targetSimulationTime(seconds, profile, splitSimulationTime(seconds));
    assert.equal(target, 3 * 60 * 60);
  });
}
