import * as assert from 'node:assert/strict';
import { float, vec2 } from 'three/tsl';
import {
  CloudOpticalVolume,
  sampleCloudOpticalVolumeCpu,
  type CloudOpticalVolumeData,
} from '../../src/render/cloud/cloud-optical-volume';
import {
  cloudRayPathLengthPerAltitude,
  integrateCloudOpticalVolumeRayNode,
} from '../../src/render/cloud/cloud-optical-ray';
import { test } from '../harness';

const EDGES_M = new Float32Array([0, 1_000, 3_000, 6_000, 8_000, 9_000]);
const WIDTH = 2;
const HEIGHT = 2;
const DEPTH = EDGES_M.length - 1;
const LIQUID_BETA = 2e-4;
const ICE_BETA = 1e-4;

function c9Data(): CloudOpticalVolumeData {
  const texels = WIDTH * HEIGHT * DEPTH;
  const liquid = new Float32Array(texels);
  const ice = new Float32Array(texels);
  for (let layer = 1; layer < 2; layer += 1) {
    liquid.fill(LIQUID_BETA, layer * WIDTH * HEIGHT, (layer + 1) * WIDTH * HEIGHT);
  }
  ice.fill(ICE_BETA, 3 * WIDTH * HEIGHT, 4 * WIDTH * HEIGHT);
  return {
    width: WIDTH,
    height: HEIGHT,
    layerEdgesM: EDGES_M,
    liquidExtinctionPerM: liquid,
    iceExtinctionPerM: ice,
  };
}

function c9Volume(): CloudOpticalVolume {
  return new CloudOpticalVolume(c9Data());
}

export function register(): void {
  test('cloud optical ray: creates a TSL graph for fixed-layer phase optical depth and transmittance', () => {
    const data = c9Data();
    const volume = new CloudOpticalVolume(data);
    try {
      const vertical = integrateCloudOpticalVolumeRayNode(volume.texture, EDGES_M, {
        originUv: vec2(0.5, 0.5),
        gridSpanEastM: 20_000,
        gridSpanNorthM: 20_000,
        uvDeltaPerAltitudeM: vec2(0, 0),
        startAltitudeM: float(0),
        endAltitudeM: float(9_000),
      });
      const fortyFiveDegrees = integrateCloudOpticalVolumeRayNode(volume.texture, EDGES_M, {
        originUv: vec2(0.5, 0.5),
        gridSpanEastM: 20_000,
        gridSpanNorthM: 20_000,
        uvDeltaPerAltitudeM: vec2(1 / 20_000, 0),
        startAltitudeM: float(0),
        endAltitudeM: float(9_000),
      });
      assert.ok(vertical && fortyFiveDegrees);

      // Independent CPU oracle for homogeneous C9 slabs. The 3–6 km gap is required to remain empty.
      assert.equal(sampleCloudOpticalVolumeCpu(data, 0.5, 0.5, 4_500).liquidExtinctionPerM, 0);
      assert.equal(sampleCloudOpticalVolumeCpu(data, 0.5, 0.5, 4_500).iceExtinctionPerM, 0);
      assert.ok(Math.abs(LIQUID_BETA * (EDGES_M[2]! - EDGES_M[1]!) - 0.4) < 1e-12);
      assert.ok(Math.abs(ICE_BETA * (EDGES_M[4]! - EDGES_M[3]!) - 0.2) < 1e-12);
      assert.ok(Math.abs(Math.exp(-0.6) - 0.5488116361) < 1e-10);
      assert.equal(cloudRayPathLengthPerAltitude(0, 0, 20_000, 20_000), 1);
      assert.ok(Math.abs(cloudRayPathLengthPerAltitude(1 / 20_000, 0, 20_000, 20_000)
        - Math.SQRT2) < 1e-12);
      assert.throws(() => cloudRayPathLengthPerAltitude(0.1, 0, 0, 20_000), /positive and finite/);
      assert.ok(Math.abs((0.4 + 0.2) * Math.SQRT2 - 0.8485281374) < 1e-10);
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
        gridSpanEastM: 20_000,
        gridSpanNorthM: 20_000,
        uvDeltaPerAltitudeM: vec2(0, 0),
        startAltitudeM: float(0),
        endAltitudeM: float(9_000),
      }), /match the volume depth/);
      assert.throws(() => integrateCloudOpticalVolumeRayNode(volume.texture,
        new Float32Array([0, 1_000, 3_000, 3_000, 8_000, 9_000]), {
          originUv: vec2(0.5, 0.5),
          gridSpanEastM: 20_000,
          gridSpanNorthM: 20_000,
          uvDeltaPerAltitudeM: vec2(0, 0),
          startAltitudeM: float(0),
          endAltitudeM: float(9_000),
        }), /strictly increasing/);
    } finally {
      volume.dispose();
    }
  });
}
