import * as assert from 'node:assert/strict';
import { formatMapScaleDistance, mapScaleFor } from '../../src/game/hud/map-scale';
import { test } from '../harness';

export function register(): void {
  test('map scale: meters-per-pixelから見やすい1/2/5距離と画面長を求める', () => {
    const scale = mapScaleFor(1);
    assert.deepEqual(scale, { distanceM: 100, widthPx: 100 });
    assert.equal(formatMapScaleDistance(scale!.distanceM), '100 m');
  });

  test('map scale: ズームに応じて縮尺バーの画面長が伸縮する', () => {
    const zoomedIn = mapScaleFor(0.8)!;
    const zoomedOut = mapScaleFor(1.5)!;
    assert.ok(zoomedIn.widthPx > 100);
    assert.ok(zoomedOut.widthPx > 100);
    assert.notEqual(zoomedIn.distanceM, zoomedOut.distanceM);
  });

  test('map scale: 太陽系スケールではGm/Tmを使う', () => {
    assert.equal(formatMapScaleDistance(2e9), '2 Gm');
    assert.equal(formatMapScaleDistance(5e12), '5 Tm');
  });
}
