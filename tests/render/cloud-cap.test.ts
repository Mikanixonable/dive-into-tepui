// 視点中心の cap の角半径の式を固定する。cap の外へ雲が出ない/内へ縮みすぎない境目はここで決まる。
import * as assert from 'node:assert/strict';
import { CLOUD_CAP_MARGIN, CLOUD_CAP_SIZE, capRadiusFor } from '../../src/render/cloud/cloud-cap';
import { CLOUD_TOP_SPAN } from '../../src/render/cloud/cumulus-shape';
import { R_EARTH_EQ } from '../../src/game/celestial/solar-system/constants';
import { test } from '../harness';

const TOP_OVER_RADIUS = CLOUD_TOP_SPAN / R_EARTH_EQ;
const DEG = Math.PI / 180;

function rhoAtAltitude(altitude: number): number {
  return (R_EARTH_EQ + altitude) / R_EARTH_EQ;
}

export function register(): void {
  test('cloud cap: 高度 400 km では地平線 + 雲頂 + 余白', () => {
    const radius = capRadiusFor(rhoAtAltitude(400e3), TOP_OVER_RADIUS);
    // 地表の地平線 19.75 度、雲頂が地平線より先まで見える分 3.93 度、余白 5 度。
    assert.ok(Math.abs(radius / DEG - (19.75 + 3.93 + 5)) < 0.05, `${radius / DEG}`);
  });

  test('cloud cap: 遠方では pi/2 で止まる', () => {
    // 正射影の半径 sin(theta) が単調でなくなる境目。越えると裏側の半球が表側と同じ uv へ写る。
    assert.equal(capRadiusFor(1e6, TOP_OVER_RADIUS), Math.PI / 2);
    assert.equal(capRadiusFor(Number.POSITIVE_INFINITY, TOP_OVER_RADIUS), Math.PI / 2);
  });

  test('cloud cap: 地表に貼り付いても正の半径を返す', () => {
    const radius = capRadiusFor(1, TOP_OVER_RADIUS);
    assert.ok(radius > CLOUD_CAP_MARGIN, `${radius}`);
    assert.ok(radius < Math.PI / 2);
    // rho は 1 を下回らないが、下回っても地平線 0 で止める。
    assert.equal(capRadiusFor(0.5, TOP_OVER_RADIUS), radius);
  });

  test('cloud cap: 高度が上がるほど広がり、余白ぶんだけ広い', () => {
    const low = capRadiusFor(rhoAtAltitude(200e3), TOP_OVER_RADIUS);
    const high = capRadiusFor(rhoAtAltitude(2000e3), TOP_OVER_RADIUS);
    assert.ok(low < high);
    assert.ok(Math.abs(
      capRadiusFor(rhoAtAltitude(400e3), TOP_OVER_RADIUS, 0) + CLOUD_CAP_MARGIN
      - capRadiusFor(rhoAtAltitude(400e3), TOP_OVER_RADIUS),
    ) < 1e-12);
  });

  test('cloud cap: 写しは正方形の 512 texel', () => {
    assert.equal(CLOUD_CAP_SIZE, 512);
  });
}
