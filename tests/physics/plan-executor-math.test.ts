// plan-executor-math.ts の回帰テスト: 燃焼時間・点火予定時刻の閉形式と、遮断判定の射影の符号。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { burnCutoffProjection, burnDurationFor, ignitionTimeFor } from '../../src/game/plan/plan-executor-math';
import { v3 } from '../../src/physics/vec3';

export function register(): void {
  test('burnDurationFor: dv/accel の閉形式', () => {
    assert.equal(burnDurationFor(100, 20), 5);
    assert.equal(burnDurationFor(0, 20), 0);
  });

  test('burnDurationFor: 加速度0以下は有限時間で消せないので Infinity', () => {
    assert.equal(burnDurationFor(100, 0), Infinity);
    assert.equal(burnDurationFor(100, -1), Infinity);
  });

  test('ignitionTimeFor: ノード時刻を挟んで対称な点火予定時刻', () => {
    // dv=100, accel=20 -> 燃焼5秒。ノード時刻を中心に前後2.5秒ずつ。
    assert.equal(ignitionTimeFor(1000, 100, 20), 997.5);
  });

  test('burnCutoffProjection: 未達なら正、噴射方向を追い越すと0以下', () => {
    const dir = v3(1, 0, 0);
    const target = v3(10, 0, 0);
    assert.ok(burnCutoffProjection(target, v3(0, 0, 0), dir) > 0);
    assert.equal(burnCutoffProjection(target, v3(10, 0, 0), dir), 0);
    assert.ok(burnCutoffProjection(target, v3(15, 0, 0), dir) < 0);
  });

  test('burnCutoffProjection: 噴射方向と無関係な成分は無視する', () => {
    const dir = v3(1, 0, 0);
    const target = v3(10, 5, -3);
    assert.equal(burnCutoffProjection(target, v3(0, 5, -3), dir), 10);
  });
}
