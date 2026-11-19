// ロスビー波の CPU 側の位相・振幅・変位場を検査する。描画側の TSL と共有するモデル式が
// 決定的で、季節的な盛衰・停滞/逆行・球面上の継ぎ目の無さを保つことを見る。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  WAVE_TROUGH_WIDTH, stormTrackCountAt, stormTrackIndexAt, waveAmplitudeAt, waveDisplacementDegAt,
  waveDriftDegAt, waveTroughLongitude,
} from '../../src/render/earth-weather/rossby-wave';

const DEGREE = Math.PI / 180;
const DAY = 86400;
const HOUR = 3600;

function driftSpeedDegPerDayAt(seconds: number): number {
  return (waveDriftDegAt(seconds + HOUR) - waveDriftDegAt(seconds - HOUR)) * DAY / (2 * HOUR);
}

export function register(): void {
  test('rossby-wave: キャリアは東進・停滞・逆行を連続に通る', () => {
    let slowest = Infinity;
    let fastest = -Infinity;
    let nearestToStationary = Infinity;
    let previous = waveDriftDegAt(0);

    for (let seconds = 0; seconds <= 120 * DAY; seconds += HOUR) {
      const drift = waveDriftDegAt(seconds);
      const speed = driftSpeedDegPerDayAt(seconds);
      slowest = Math.min(slowest, speed);
      fastest = Math.max(fastest, speed);
      nearestToStationary = Math.min(nearestToStationary, Math.abs(speed));
      assert.ok(Math.abs(drift - previous) < 0.5, '位相ドリフトに時間の跳びがある');
      previous = drift;
    }

    assert.ok(slowest < -0.5, `逆行がない: ${slowest} deg/day`);
    assert.ok(fastest > 0.5, `東進がない: ${fastest} deg/day`);
    assert.ok(nearestToStationary < 0.05, `停滞局面を通らない: ${nearestToStationary} deg/day`);
  });

  test('rossby-wave: 錨のドリフトと谷の移動が一致する', () => {
    for (const hemisphere of [-1, 1]) {
      for (const seconds of [0, 11 * DAY, 47 * DAY, 103 * DAY]) {
        const interval = 12 * HOUR;
        const troughAdvance = (waveTroughLongitude(2, seconds + interval, hemisphere)
          - waveTroughLongitude(2, seconds, hemisphere)) / DEGREE;
        const anchorDrift = waveDriftDegAt(seconds + interval) - waveDriftDegAt(seconds);
        assert.ok(Math.abs(troughAdvance - anchorDrift) < 1e-9);
      }

      const spacing = waveTroughLongitude(3, 35 * DAY, hemisphere)
        - waveTroughLongitude(2, 35 * DAY, hemisphere);
      assert.ok(Math.abs(spacing / DEGREE - WAVE_TROUGH_WIDTH) < 1e-9);
    }
  });

  test('rossby-wave: 振幅は決定的に盛衰し、範囲を保つ', () => {
    const latitude = 45 * DEGREE;
    const longitude = 140 * DEGREE;
    let minimum = Infinity;
    let maximum = -Infinity;

    for (let seconds = 0; seconds <= 100 * DAY; seconds += DAY) {
      const amplitude = waveAmplitudeAt(latitude, longitude, seconds);
      assert.equal(amplitude, waveAmplitudeAt(latitude, longitude, seconds));
      minimum = Math.min(minimum, amplitude);
      maximum = Math.max(maximum, amplitude);
    }

    assert.ok(minimum >= 0);
    assert.ok(maximum <= 1.5);
    assert.ok(maximum - minimum > 0.5, `振幅の盛衰が小さい: ${minimum}..${maximum}`);
  });

  test('rossby-wave: 複数波長で谷の間隔が不均一になり、変位は数度に収まる', () => {
    const latitude = 45 * DEGREE;
    const seconds = 35 * DAY;
    const sampleCount = 720;
    const values = Array.from({ length: sampleCount }, (_, index) =>
      waveDisplacementDegAt(latitude, (index * 2 * Math.PI) / sampleCount, seconds));
    const minima: number[] = [];
    let maximumDisplacement = 0;

    for (let index = 0; index < sampleCount; index += 1) {
      const previous = values[(index + sampleCount - 1) % sampleCount]!;
      const value = values[index]!;
      const next = values[(index + 1) % sampleCount]!;
      if (value < previous && value <= next) minima.push((index * 360) / sampleCount);
      maximumDisplacement = Math.max(maximumDisplacement, Math.abs(value));
    }
    const spacings = minima.map((longitude, index) => {
      const next = minima[(index + 1) % minima.length]!;
      return (next + 360 - longitude) % 360;
    });

    assert.ok(minima.length >= 4, `谷が少ない: ${minima.length}`);
    assert.ok(Math.max(...spacings) - Math.min(...spacings) > 15, '谷の間隔が一様');
    assert.ok(maximumDisplacement > 5, `変位が小さすぎる: ${maximumDisplacement}°`);
    assert.ok(maximumDisplacement < 14, `変位が過大: ${maximumDisplacement}°`);
  });

  test('rossby-wave: 半球の位相は独立し、赤道・極・経度の継ぎ目で連続する', () => {
    const seconds = 35 * DAY;
    let hemisphericDifference = 0;

    for (let degree = 0; degree < 360; degree += 1) {
      const longitude = degree * DEGREE;
      const north = waveDisplacementDegAt(45 * DEGREE, longitude, seconds);
      const south = waveDisplacementDegAt(-45 * DEGREE, longitude, seconds);
      hemisphericDifference = Math.max(hemisphericDifference, Math.abs(north - south));
      assert.ok(Math.abs(waveDisplacementDegAt(0, longitude, seconds)) < 1e-12);
      assert.ok(Math.abs(waveDisplacementDegAt(89 * DEGREE, longitude, seconds)) < 1e-12);
    }
    assert.ok(hemisphericDifference > 2, `半球の蛇行位相が揃いすぎる: ${hemisphericDifference}°`);

    const epsilon = 1e-7;
    const west = waveDisplacementDegAt(45 * DEGREE, -Math.PI + epsilon, seconds);
    const east = waveDisplacementDegAt(45 * DEGREE, Math.PI - epsilon, seconds);
    assert.ok(Math.abs(west - east) < 1e-3, '日付変更線に変位の継ぎ目がある');

    for (const longitude of [0, 1.4, -2.2]) {
      const nearTropicalNorth = waveDisplacementDegAt(10.01 * DEGREE, longitude, seconds);
      const nearTropicalSouth = waveDisplacementDegAt(-10.01 * DEGREE, longitude, seconds);
      const nearPolar = waveDisplacementDegAt(79.99 * DEGREE, longitude, seconds);
      assert.ok(Math.abs(nearTropicalNorth - nearTropicalSouth) < 1e-3, '赤道側の包絡に継ぎ目がある');
      assert.ok(Math.abs(nearPolar) < 1e-3, '極側の包絡が滑らかに消えていない');
    }
  });

  test('rossby-wave: ストームトラック番号は半球ごとに周期的に引ける', () => {
    const tracks = [
      { longitude: 140, hemisphere: 1, index: 0 },
      { longitude: -60, hemisphere: 1, index: 1 },
      { longitude: 20, hemisphere: 1, index: 2 },
      { longitude: 30, hemisphere: -1, index: 0 },
      { longitude: 150, hemisphere: -1, index: 1 },
    ];
    assert.equal(stormTrackCountAt(1), 3);
    assert.equal(stormTrackCountAt(-1), 2);
    for (const { longitude, hemisphere, index } of tracks) {
      assert.equal(stormTrackIndexAt(longitude * DEGREE, hemisphere), index);
      assert.equal(stormTrackIndexAt((longitude + 360) * DEGREE, hemisphere), index);
    }
  });
}
