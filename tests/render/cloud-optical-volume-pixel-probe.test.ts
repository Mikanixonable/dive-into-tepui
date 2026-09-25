import * as assert from 'node:assert/strict';
import {
  sampleCloudOpticalVolumeCpu, type CloudOpticalVolumeData,
} from '../../src/render/cloud/cloud-optical-volume';
import { test } from '../harness';

const DATA: CloudOpticalVolumeData = {
  width: 2,
  height: 2,
  layerEdgesM: new Float32Array([0, 1_000, 3_000]),
  liquidExtinctionPerM: new Float32Array([0.001, 0.002, 0.003, 0.004, 0.01, 0.02, 0.03, 0.04]),
  iceExtinctionPerM: new Float32Array([0.005, 0.006, 0.007, 0.008, 0.05, 0.06, 0.07, 0.08]),
};

function assertSample(altitudeM: number, u: number, v: number, liquid: number, ice: number): void {
  const sample = sampleCloudOpticalVolumeCpu(DATA, u, v, altitudeM);
  assert.ok(Math.abs(sample.liquidExtinctionPerM - liquid) < 1e-8);
  assert.ok(Math.abs(sample.iceExtinctionPerM - ice) < 1e-8);
}

export function register(): void {
  test('cloud optical pixel probe: CPU oracle uses half-open discrete layers and clamp-edge bilinear xy', () => {
    assertSample(0, 0.5, 0.5, 0.0025, 0.0065);
    // Internal boundaries select the upper layer; the top boundary remains in the final layer.
    assertSample(1_000, 0.5, 0.5, 0.025, 0.065);
    assertSample(3_000, 0.5, 0.5, 0.025, 0.065);
    assertSample(999.9, 0, 0, 0.001, 0.005);
    assert.throws(() => sampleCloudOpticalVolumeCpu(DATA, 0.5, 0.5, -0.1), RangeError);
    assert.throws(() => sampleCloudOpticalVolumeCpu(DATA, 0.5, 0.5, 3_000.1), RangeError);
  });
}
