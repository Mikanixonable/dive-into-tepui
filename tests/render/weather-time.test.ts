// 雲モデルの時刻正規化の回帰テスト。大きな絶対時刻や日境界で日周位相が飛ばないことを確認する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  SIMULATION_DAY_SECONDS, simulationSecondsPerFrame, splitEpochTime, splitSimulationTime,
} from '../../src/render/cloud/weather-time';

export function register(): void {
  test('weather-time: 日境界と負の時刻を正規化する', () => {
    assert.deepEqual(splitSimulationTime(0), { dayIndex: 0, secondsOfDay: 0 });
    assert.deepEqual(splitSimulationTime(SIMULATION_DAY_SECONDS + 12), { dayIndex: 1, secondsOfDay: 12 });
    assert.deepEqual(splitSimulationTime(-1), { dayIndex: -1, secondsOfDay: SIMULATION_DAY_SECONDS - 1 });
  });

  test('weather-time: 巨大な時刻を日番号と日内秒へ分ける', () => {
    const result = splitEpochTime(1.7e12);
    assert.ok(result.dayIndex > 0);
    assert.ok(result.secondsOfDay >= 0 && result.secondsOfDay < SIMULATION_DAY_SECONDS);
  });

  test('weather-time: フレーム間のsimulation時間は絶対値で返す', () => {
    assert.equal(simulationSecondsPerFrame(null, 5), 0);
    assert.equal(simulationSecondsPerFrame(100, 40), 60);
    assert.equal(simulationSecondsPerFrame(0, Number.NaN), 0);
  });
}
