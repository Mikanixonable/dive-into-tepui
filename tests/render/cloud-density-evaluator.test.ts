import * as assert from 'node:assert/strict';
import {
  CLOUD_ICE_EDGE_M,
  CLOUD_ICE_HALF_THICKNESS_M,
  CLOUD_LIQUID_BASE_M,
  CLOUD_LIQUID_EDGE_M,
  cloudColumnExtinctionAtAltitude,
  cloudLayerFractionAtAltitude,
} from '../../src/render/cloud/cloud-density-evaluator';
import { test } from '../harness';

function integrate(
  tau: number, bottomM: number, topM: number, edgeM: number, stepM = 5,
): number {
  let total = 0;
  for (let z = bottomM; z < topM; z += stepM) {
    total += cloudColumnExtinctionAtAltitude(
      tau, z + stepM / 2, bottomM, topM, edgeM,
    ) * stepM;
  }
  return total;
}

export function register(): void {
  test('cloud density evaluator: normalized vertical profile preserves column optical depth', () => {
    const bottomM = CLOUD_LIQUID_BASE_M;
    const topM = 8_700;
    const tau = 2.4;
    assert.ok(Math.abs(integrate(tau, bottomM, topM, CLOUD_LIQUID_EDGE_M) - tau) < 1e-4);
  });

  test('cloud density evaluator: separated liquid and ice layers retain a clear C9 gap', () => {
    const liquidTopM = 5_000;
    const iceCenterM = 15_000;
    const iceBottomM = iceCenterM - CLOUD_ICE_HALF_THICKNESS_M;
    const iceTopM = iceCenterM + CLOUD_ICE_HALF_THICKNESS_M;
    assert.ok(cloudLayerFractionAtAltitude(2_000, CLOUD_LIQUID_BASE_M, liquidTopM, CLOUD_LIQUID_EDGE_M) > 0);
    assert.equal(cloudLayerFractionAtAltitude(10_000, CLOUD_LIQUID_BASE_M, liquidTopM, CLOUD_LIQUID_EDGE_M), 0);
    assert.equal(cloudLayerFractionAtAltitude(10_000, iceBottomM, iceTopM, CLOUD_ICE_EDGE_M), 0);
    assert.ok(cloudLayerFractionAtAltitude(15_000, iceBottomM, iceTopM, CLOUD_ICE_EDGE_M) > 0);
  });

  test('cloud density evaluator: invalid layer geometry is rejected', () => {
    assert.throws(() => cloudLayerFractionAtAltitude(0, 0, 100, 60), RangeError);
    assert.throws(() => cloudColumnExtinctionAtAltitude(-1, 0, 0, 1_000, 100), RangeError);
  });
}
