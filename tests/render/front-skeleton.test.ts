// 天気図用の前線骨格(front-skeleton.ts)の回帰テスト。GPU 側と同じく、前線の形と強さは
// 現在の谷の深さから独立した frontDepth で駆動できる。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { frontSpinesOf, frontStrengthOf } from '../../src/render/earth-weather/front-skeleton';
import type { PressurePlacement } from '../../src/render/earth-weather/tracks';

const DEGREE = Math.PI / 180;
const EARTH_RADIUS = 6.371e6;
const EARTH_ROTATION_PERIOD = 86164.0905;

// この層の回帰テストを登録する。
export function register(): void {
  test('front-skeleton: 残留前線は谷が埋まっても形と強さを保つ', () => {
    const remnant: PressurePlacement = {
      latitude: 40 * DEGREE,
      longitude: 0,
      depth: 0,
      radius: 500e3,
      elongation: 1.3,
      fronts: 'pair',
      frontDepth: 24,
      wound: 0,
    };
    const spines = frontSpinesOf(remnant, EARTH_RADIUS, EARTH_ROTATION_PERIOD);
    assert.ok(spines.some(({ kind }) => kind === 'cold'), '残留した寒冷前線の腕が無い');
    assert.equal(frontStrengthOf(remnant), 1);

    const ordinary: PressurePlacement = { ...remnant, depth: 12, frontDepth: undefined };
    assert.equal(frontStrengthOf(ordinary), 0.5, '省略時に谷の深さへフォールバックする');
  });
}
