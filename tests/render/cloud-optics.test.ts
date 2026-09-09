import * as assert from 'node:assert/strict';
import {
  columnOpticalDepthFromCoverage,
  composeCloudEvents,
  shellAirmass,
  transmittanceFromColumnOpticalDepth,
  type CloudOpticalEvent,
} from '../../src/render/cloud/cloud-optics';
import { test } from '../harness';

function event(
  radiance: number, backgroundTransmittance: number, transmittance: number,
): CloudOpticalEvent {
  return { radiance, backgroundTransmittance, transmittance };
}

export function register(): void {
  test('cloud optics: Rは柱光学深さへ変換しGを混ぜない', () => {
    assert.equal(columnOpticalDepthFromCoverage(0), 0);
    assert.equal(columnOpticalDepthFromCoverage(0.5), Math.log(2));
    assert.ok(Math.abs(columnOpticalDepthFromCoverage(1) + Math.log(0.01)) < 1e-14);
  });

  test('cloud optics: 柱光学深さとairmassはexp(-tau)を一度だけ適用する', () => {
    const airmass = shellAirmass(1, 1_000, 1_000_000);
    assert.equal(airmass, 1);
    assert.equal(
      transmittanceFromColumnOpticalDepth(2, 3),
      Math.exp(-6),
    );
    assert.ok(Number.isFinite(shellAirmass(0, 1_000, 1_000_000)));
  });

  test('cloud optics: 入口と出口は別イベントとして各一回だけ合成する', () => {
    const entry = transmittanceFromColumnOpticalDepth(1, 1);
    const exit = transmittanceFromColumnOpticalDepth(1, 1);
    const result = composeCloudEvents(
      [event(2, 1, entry), event(3, 1, exit)],
      0.8,
      10,
    );
    assert.equal(result.transmittance, 0.8 * entry * exit);
    assert.equal(result.radiance, 10 + 2 + entry * 3);
  });

  test('cloud optics: 接線・非交差・雲なしはイベントなしで背景を変えない', () => {
    const result = composeCloudEvents([], 0.75, 4);
    assert.deepEqual(result, { transmittance: 0.75, radiance: 4 });
  });

  test('cloud optics: speciesは近い順にBeer-Lambert積と放射加算を行う', () => {
    const near = event(2, 0.5, 0.5);
    const far = event(4, 0.25, 0.25);
    const result = composeCloudEvents([near, far], 0.8, 1);
    assert.equal(result.transmittance, 0.8 * 0.5 * 0.25);
    assert.equal(result.radiance, 1 + 0.5 * 2 + 0.5 * 0.25 * 4);
  });

  test('cloud optics: 背景大気透過はイベント位置へ一度だけ掛け雲透過をradianceへ掛けない', () => {
    const result = composeCloudEvents([event(4, 0.25, 0.5)], 0.8, 7);
    assert.equal(result.transmittance, 0.8 * 0.5);
    assert.equal(result.radiance, 7 + 0.25 * 4);
  });
}
