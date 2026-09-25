import * as assert from 'node:assert/strict';
import { float, vec2 } from 'three/tsl';
import { CloudOpticalVolume } from '../../src/render/cloud/cloud-optical-volume';
import { integrateCloudOpticalVolumeRayNode } from '../../src/render/cloud/cloud-optical-ray';
import { test } from '../harness';

const EDGES_M = new Float32Array([0, 1_000, 3_000, 6_000, 8_000, 9_000]);
const WIDTH = 2;
const HEIGHT = 2;
const DEPTH = EDGES_M.length - 1;
const LIQUID_BETA = 2e-4;
const ICE_BETA = 1e-4;

function c9Volume(): CloudOpticalVolume {
  const texels = WIDTH * HEIGHT * DEPTH;
  const liquid = new Float32Array(texels);
  const ice = new Float32Array(texels);
  for (let layer = 1; layer < 3; layer += 1) {
    liquid.fill(LIQUID_BETA, layer * WIDTH * HEIGHT, (layer + 1) * WIDTH * HEIGHT);
  }
  ice.fill(ICE_BETA, 3 * WIDTH * HEIGHT, 4 * WIDTH * HEIGHT);
  return new CloudOpticalVolume({
    width: WIDTH,
    height: HEIGHT,
    layerEdgesM: EDGES_M,
    liquidExtinctionPerM: liquid,
    iceExtinctionPerM: ice,
  });
}

export function register(): void {
  test('cloud optical ray: creates a TSL graph for fixed-layer phase optical depth and transmittance', () => {
    const volume = c9Volume();
    try {
      const vertical = integrateCloudOpticalVolumeRayNode(volume.texture, EDGES_M, {
        originUv: vec2(0.5, 0.5),
        uvDeltaPerAltitudeM: vec2(0, 0),
        startAltitudeM: float(0),
        endAltitudeM: float(9_000),
      });
      const fortyFiveDegrees = integrateCloudOpticalVolumeRayNode(volume.texture, EDGES_M, {
        originUv: vec2(0.5, 0.5),
        uvDeltaPerAltitudeM: vec2(1 / 20_000, 0),
        startAltitudeM: float(0),
        endAltitudeM: float(9_000),
      });
      assert.ok(vertical && fortyFiveDegrees);

      // Independent analytic C9 targets for the GPU readback harness. This unit test validates graph
      // construction only; it does not claim that a GPU executed either graph.
      assert.ok(Math.abs(LIQUID_BETA * 2_000 - 0.4) < 1e-12);
      assert.ok(Math.abs(ICE_BETA * 2_000 - 0.2) < 1e-12);
      const tau45 = 0.6 / Math.cos(Math.PI / 4);
      assert.ok(Math.abs(tau45 - 0.8485281374) < 1e-10);
    } finally {
      volume.dispose();
    }
  });

  test('cloud optical ray: rejects layer boundaries that do not describe the volume', () => {
    const volume = c9Volume();
    try {
      assert.throws(() => integrateCloudOpticalVolumeRayNode(volume.texture, new Float32Array([0, 9_000]), {
        originUv: vec2(0.5, 0.5),
        uvDeltaPerAltitudeM: vec2(0, 0),
        startAltitudeM: float(0),
        endAltitudeM: float(9_000),
      }), /match the volume depth/);
      assert.throws(() => integrateCloudOpticalVolumeRayNode(volume.texture,
        new Float32Array([0, 1_000, 3_000, 3_000, 8_000, 9_000]), {
          originUv: vec2(0.5, 0.5),
          uvDeltaPerAltitudeM: vec2(0, 0),
          startAltitudeM: float(0),
          endAltitudeM: float(9_000),
        }), /strictly increasing/);
    } finally {
      volume.dispose();
    }
  });
}
