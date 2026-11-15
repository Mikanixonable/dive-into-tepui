// 雲影の幾何評価の期待値の式の検査。合成ケースと評価ツールが共有する
// tools/render-lab/cloud-shadow-geometry-model.ts の式を、平地の極限・単調性・光路の上限と
// 地平の頭打ちで固定する。
import * as assert from 'node:assert/strict';
import { cumulusAmountFromTopAltitude } from '../../src/render/cloud/cloud-kind';
import * as model from '../../tools/render-lab/cloud-shadow-geometry-model';
import { test } from '../harness';

const RAD = Math.PI / 180;

export function register(): void {
  test('shadow geometry: 期待値の式は量→雲頂の写像を本番と同じ式で引く', () => {
    for (const h of [1500, 4000, 8000, 12000, 17000]) {
      assert.equal(model.cumulusAmountForTopAltitudeM(h), cumulusAmountFromTopAltitude(h));
    }
  });

  test('shadow geometry: 低い天頂角では遠端が r + H·tan(θ) の平地の値へ揃う', () => {
    for (const [r, h] of [[3e3, 1500], [3e3, 8000], [10e3, 4000], [10e3, 12000]] as const) {
      const flat = r + h * Math.tan(30 * RAD);
      const curved = model.expectedFarEdgeM(r, h, 30 * RAD);
      assert.ok(Math.abs(curved - flat) < flat * 0.08,
        `r=${r} h=${h}: flat ${flat} vs ${curved}`);
    }
  });

  test('shadow geometry: 遠端は雲頂が高いほど・天頂角が大きいほど長い', () => {
    for (const zenith of [30, 60, 75, 85]) {
      const zenithRad = zenith * RAD;
      let previous = 0;
      for (const h of [1500, 4000, 8000, 12000]) {
        const far = model.expectedFarEdgeM(3e3, h, zenithRad);
        assert.ok(far > previous, `z${zenith} h=${h}: ${far} <= ${previous}`);
        previous = far;
      }
      for (const h of [4000, 12000]) {
        assert.ok(model.expectedFarEdgeM(3e3, h, zenithRad)
          > model.expectedFarEdgeM(3e3, h, (zenith - 15) * RAD));
      }
    }
  });

  test('shadow geometry: 天頂角 0 では影は円板の下へ収まり重心はずれない', () => {
    for (const [r, h] of [[3e3, 4000], [10e3, 12000]] as const) {
      // 天頂角 0 では柱の錐の裾(半径 r·(1+H/R)ぶん広がる)までしか影は届かない。
      const far = model.expectedFarEdgeM(r, h, 0);
      assert.ok(far >= r && far < r * 1.02, `r=${r} h=${h}: far ${far}`);
      // 錐の裾は両側へ対称に広がるので、重心は円板の中心に残る(数値積分の残留だけ)。
      assert.ok(Math.abs(model.expectedCentroidOffsetM(r, h, 0)) < 1e-2);
    }
  });

  test('shadow geometry: 重心のずれは 0 から遠端のあいだにあり、天頂角で増える', () => {
    for (const zenith of [0, 30, 60, 75, 85]) {
      const zenithRad = zenith * RAD;
      for (const [r, h] of [[3e3, 4000], [10e3, 12000]] as const) {
        const ctr = model.expectedCentroidOffsetM(r, h, zenithRad);
        const far = model.expectedFarEdgeM(r, h, zenithRad);
        assert.ok(ctr >= -1e-9 && ctr <= far, `z${zenith} r=${r} h=${h}: ctr ${ctr} far ${far}`);
      }
      for (const h of [4000, 12000]) {
        assert.ok(model.expectedCentroidOffsetM(3e3, h, zenithRad)
          >= model.expectedCentroidOffsetM(3e3, h, Math.max(0, zenith - 15) * RAD) - 1e-9);
      }
    }
  });

  test('shadow geometry: 遠端は光路の上限と地平の手前で頭打ちになる', () => {
    const r = 3e3;
    for (const zenith of [85, 86, 88]) {
      for (const h of [4000, 12000, 15000]) {
        const far = model.expectedFarEdgeM(r, h, zenith * RAD);
        // 遠端の受け手から円板上端の角へ届く光路は、MAX_LIGHT_PATH を超えない。
        const phi = far / model.BODY_RADIUS_M;
        const delta = r / model.BODY_RADIUS_M;
        const a = [ -Math.sin(phi) * model.BODY_RADIUS_M, Math.cos(phi) * model.BODY_RADIUS_M ];
        const q = [
          -Math.sin(delta) * (model.BODY_RADIUS_M + h),
          Math.cos(delta) * (model.BODY_RADIUS_M + h),
        ];
        const chord = Math.hypot(q[0] - a[0], q[1] - a[1]);
        assert.ok(chord <= model.MAX_LIGHT_PATH_M * 1.001,
          `z${zenith} h=${h}: chord ${chord} > MAX_LIGHT_PATH`);
        // 受け手の局地天頂角は 90° を超えない(恒星が地平線の上にある)。
        assert.ok(phi + zenith * RAD <= Math.PI / 2 + 1e-9,
          `z${zenith} h=${h}: far receiver zenith ${phi + zenith * RAD}`);
      }
    }
    // 光路の上限が拘束になっている条件では、遠端の受け手から円板上端の角への弦がちょうど
    // MAX_LIGHT_PATH に張り、上限を外した幾何の遠端より手前へ切れる。
    const zenith = 86 * RAD;
    const h = 15000;
    const far = model.expectedFarEdgeM(r, h, zenith) / model.BODY_RADIUS_M;
    const delta = r / model.BODY_RADIUS_M;
    const cosC = (model.BODY_RADIUS_M ** 2 + (model.BODY_RADIUS_M + h) ** 2
      - model.MAX_LIGHT_PATH_M ** 2) / (2 * model.BODY_RADIUS_M * (model.BODY_RADIUS_M + h));
    const pathFar = delta + Math.acos(cosC);
    assert.ok(Math.abs(far - pathFar) < 1e-6, `far ${far} vs path cap ${pathFar}`);
    const geoFar = Math.asin(Math.min(1,
      (1 + h / model.BODY_RADIUS_M) * Math.sin(zenith + delta))) - zenith;
    assert.ok(pathFar < geoFar && pathFar < Math.PI / 2 - zenith,
      `path cap ${pathFar} should be the binding bound (geo ${geoFar})`);
  });

  test('shadow geometry: 最小透過率は雲頂が高いほど小さく 0 より大きい', () => {
    let previous = 1;
    for (const h of [1500, 4000, 8000, 12000]) {
      const t = model.expectedMinTransmittance(h);
      assert.ok(t > 0 && t <= previous, `h=${h}: ${t}`);
      previous = t;
    }
  });
}
