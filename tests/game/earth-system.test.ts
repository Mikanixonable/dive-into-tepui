// 地球系の実体へ地表facadeを接続しても、fallbackの表面URLと月の見た目を保つ。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { StarMotion } from '../../src/physics/celestial-motion';
import {
  EARTH_SURFACE_FIXTURE_SOURCE, EARTH_TEXTURE, earthSystem,
} from '../../src/game/celestial/solar-system/earth-system';
import { SUN } from '../../src/game/celestial/solar-system/sun';

export function register(): void {
  test('earth system: 地球はfallbackテクスチャを保ち、月の表面は変更しない', () => {
    const bodies = earthSystem(new StarMotion(SUN), {}, 0);
    assert.equal(bodies.earth.surfaceTextureUrl, EARTH_TEXTURE.url);
    assert.match(bodies.moon.surfaceTextureUrl ?? '', /8k_moon\.jpg$/);
    assert.equal(EARTH_SURFACE_FIXTURE_SOURCE.climateMapUrls.length, 12);
  });
}
