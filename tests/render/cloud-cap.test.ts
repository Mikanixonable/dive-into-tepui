// 視点中心の cap の角半径の式を固定する。cap の外へ雲が出ない/内へ縮みすぎない境目はここで決まる。
import * as assert from 'node:assert/strict';
import { CLOUD_CAP_MARGIN, CLOUD_CAP_SIZE, capRadiusFor, snapCap } from '../../src/render/cloud/cloud-cap';
import { CLOUD_TOP_SPAN } from '../../src/render/cloud/cumulus-shape';
import { R_EARTH_EQ } from '../../src/game/celestial/solar-system/earth-system';
import { test } from '../harness';

const TOP_OVER_RADIUS = CLOUD_TOP_SPAN / R_EARTH_EQ;
const DEG = Math.PI / 180;

function rhoAtAltitude(altitude: number): number {
  return (R_EARTH_EQ + altitude) / R_EARTH_EQ;
}

export function register(): void {
  test('cloud cap: 高度 400 km では地平線 + 雲頂 + 余白', () => {
    const radius = capRadiusFor(rhoAtAltitude(400e3), TOP_OVER_RADIUS);
    // 地表の地平線 19.75 度、雲頂が地平線より先まで見える分 4.18 度、余白 5 度。
    assert.ok(Math.abs(radius / DEG - (19.75 + 4.18 + 5)) < 0.05, `${radius / DEG}`);
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
  test('cloud cap: 格子へ揃えた cap は、要る円板を必ず覆う', () => {
    // 揃えた中心と直下点の大円距離 + 要る半径 ≦ 揃えた半径。高度・緯度・経度を振って確かめる。
    const centralAngle = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
      const cos = Math.sin(lat1) * Math.sin(lat2) + Math.cos(lat1) * Math.cos(lat2) * Math.cos(lon1 - lon2);
      return Math.acos(Math.max(-1, Math.min(1, cos)));
    };
    for (const altitude of [150e3, 400e3, 2000e3, 36000e3]) {
      const need = capRadiusFor(rhoAtAltitude(altitude), TOP_OVER_RADIUS);
      for (let latitude = -89.5; latitude <= 89.5; latitude += 7.3) {
        for (let longitude = -179; longitude <= 179; longitude += 11.7) {
          const snapped = snapCap(latitude * DEG, longitude * DEG, need);
          const offset = centralAngle(latitude * DEG, longitude * DEG, snapped.latitude, snapped.longitude);
          assert.ok(Math.min(need + offset, Math.PI / 2) <= snapped.radius + 1e-12,
            `alt ${altitude} lat ${latitude} lon ${longitude}: ${need + offset} > ${snapped.radius}`);
        }
      }
    }
  });

  test('cloud cap: 直下点が少し動いても cap は置き直されない', () => {
    // 低軌道で直下点を 1 km ずつ 50 km 動かしたとき、置き方が変わる回数は刻み(8 texel ≒ 80 km)に 1 回以下。
    const need = capRadiusFor(rhoAtAltitude(400e3), TOP_OVER_RADIUS);
    let changes = 0;
    let previous = snapCap(30 * DEG, 10 * DEG, need);
    for (let index = 1; index <= 50; index++) {
      const next = snapCap(30 * DEG + (index * 1000) / R_EARTH_EQ, 10 * DEG, need);
      if (next.latitude !== previous.latitude || next.radius !== previous.radius) changes++;
      previous = next;
    }
    assert.ok(changes <= 1, `${changes}`);
  });

  test('cloud cap: 揃えた半径は高度の連続な変化に対して段で変わる', () => {
    const radii = new Set<number>();
    for (let altitude = 380e3; altitude <= 420e3; altitude += 1e3) {
      radii.add(snapCap(0, 0, capRadiusFor(rhoAtAltitude(altitude), TOP_OVER_RADIUS)).radius);
    }
    assert.ok(radii.size <= 2, `${radii.size}`);
  });
}
