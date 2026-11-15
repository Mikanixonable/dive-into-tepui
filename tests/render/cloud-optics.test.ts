import * as assert from 'node:assert/strict';
import {
  cloudReflectance, columnOpticalDepthFromOpacity, composeCloudEvents,
  fractionalTransmittance, shellAirmass, transmittanceFromColumnOpticalDepth,
  ICE_CLOUD_ASYMMETRY, LIQUID_CLOUD_ASYMMETRY,
  type CloudOpticalEvent,
} from '../../src/render/cloud/cloud-optics';
import { test } from '../harness';

function event(
  radiance: number, backgroundTransmittance: number, transmittance: number,
): CloudOpticalEvent {
  return { radiance, backgroundTransmittance, transmittance };
}

export function register(): void {
  test('cloud optics: 不透明度は柱光学深さへ変換する', () => {
    assert.equal(columnOpticalDepthFromOpacity(0), 0);
    assert.equal(columnOpticalDepthFromOpacity(0.5), Math.log(2));
    assert.ok(Math.abs(columnOpticalDepthFromOpacity(1) + Math.log(0.01)) < 1e-14);
  });

  test('cloud optics: 柱光学深さとairmassはexp(-tau)を一度だけ適用する', () => {
    const tau = 2;
    const airmass = shellAirmass(1, 1_000, 1_000_000);
    assert.equal(airmass, 1);
    assert.equal(transmittanceFromColumnOpticalDepth(tau, 1), Math.exp(-tau));
    assert.equal(transmittanceFromColumnOpticalDepth(tau, 3), Math.exp(-tau * 3));
    assert.ok(Number.isFinite(shellAirmass(0, 1_000, 1_000_000)));
  });

  test('cloud optics: 反射率は光学的厚みとともに単調に増え 0 ≤ R < 1 に収まる', () => {
    for (const g of [LIQUID_CLOUD_ASYMMETRY, ICE_CLOUD_ASYMMETRY]) {
      const taus = [0, 0.1, 0.5, 1, 3, 10, 60, 300, 1e6];
      for (let i = 0; i < taus.length; i += 1) {
        const r = cloudReflectance(taus[i]!, g);
        assert.ok(r >= 0 && r < 1, `tau=${taus[i]} g=${g} の R=${r} が [0,1) を外れた`);
        if (i > 0) assert.ok(r > cloudReflectance(taus[i - 1]!, g));
      }
    }
  });

  test('cloud optics: 反射率は τ→0 で 0、負の深さは 0 へクランプ、透過率は 1 − R', () => {
    for (const g of [LIQUID_CLOUD_ASYMMETRY, ICE_CLOUD_ASYMMETRY]) {
      assert.equal(cloudReflectance(0, g), 0);
      assert.equal(cloudReflectance(-3, g), 0);
      const r = cloudReflectance(2, g);
      assert.ok(Math.abs((1 - r) + r - 1) < 1e-15);
    }
  });

  test('cloud optics: 反射率の既知の値(γ = 0.75(1−g)、R = γτ/(1+γτ))', () => {
    // g=0.85: γ = 0.1125。τ = 8 → 0.9/1.9、τ = 60 → 6.75/7.75。
    assert.ok(Math.abs(cloudReflectance(8, 0.85) - 0.9 / 1.9) < 1e-15);
    assert.ok(Math.abs(cloudReflectance(60, 0.85) - 6.75 / 7.75) < 1e-15);
    // g=0.75: γ = 0.1875。τ = 3 → 0.5625/1.5625、τ = 1/0.1875 → 0.5。
    assert.ok(Math.abs(cloudReflectance(3, 0.75) - 0.5625 / 1.5625) < 1e-15);
    assert.ok(Math.abs(cloudReflectance(1 / 0.1875, 0.75) - 0.5) < 1e-15);
    // 前向き散乱が強いほど同じ厚みで返す光は弱い。
    assert.ok(cloudReflectance(3, ICE_CLOUD_ASYMMETRY) > cloudReflectance(3, LIQUID_CLOUD_ASYMMETRY));
  });

  test('cloud optics: 積雲の柱を分割しても透過率が保たれ、別の柱は乗算される', () => {
    const reflected = 0.6;
    const fullColumn = fractionalTransmittance(reflected, 1);
    assert.equal(fullColumn, 0.4);
    assert.equal(fractionalTransmittance(reflected, 0), 1);
    assert.equal(fractionalTransmittance(0, 1_000), 1);

    for (const segments of [2, 3, 10, 64]) {
      let splitColumn = 1;
      for (let i = 0; i < segments; i += 1) {
        splitColumn *= fractionalTransmittance(reflected, 1 / segments);
      }
      assert.ok(Math.abs(splitColumn - fullColumn) < 1e-14, `segments=${segments}`);
    }

    const twoColumns = fractionalTransmittance(0.5, 1) * fractionalTransmittance(0.5, 1);
    assert.ok(Math.abs(twoColumns - 0.25) < 1e-15);
  });

  test('cloud optics: 柱光学深さとairmassは掛けてから反射率へ通す(掠めるほど R が大きい)', () => {
    const airmass = shellAirmass(1, 1_000, 1_000_000);
    assert.equal(airmass, 1);
    const vertical = cloudReflectance(2 * 1, ICE_CLOUD_ASYMMETRY);
    const slanted = cloudReflectance(2 * 3, ICE_CLOUD_ASYMMETRY);
    assert.ok(slanted > vertical);
    assert.ok(Number.isFinite(shellAirmass(0, 1_000, 1_000_000)));
  });

  test('cloud optics: 入口と出口は別イベントとして各一回だけ合成する', () => {
    const entry = 1 - cloudReflectance(1, ICE_CLOUD_ASYMMETRY);
    const exit = 1 - cloudReflectance(1, ICE_CLOUD_ASYMMETRY);
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

  test('cloud optics: speciesは近い順に透過率の積と放射加算を行う', () => {
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
