// 相別・高度層別消散の Float32 texture 順序を独立したrow-major oracleで検査する。
import * as assert from 'node:assert/strict';
import { v3 } from '../../src/math/vec3';
import { sampleConvectiveCloudEvents } from '../../src/game/cloud/cloud-events';
import { reconstructCloudEventMaterialCohorts } from '../../src/game/cloud/cloud-event-transport';
import { depositCloudEventMaterialCohorts } from '../../src/game/cloud/cloud-event-local-deposition';
import { cloudOpticalVolumeFrameFromExtinction } from '../../src/game/cloud/cloud-optical-volume-frame';
import { extinctionFromCloudMass } from '../../src/game/cloud/cloud-mass-extinction';
import type { CloudMassGrid } from '../../src/game/cloud/cloud-mass-deposition';
import type { CloudExtinctionLayer } from '../../src/game/cloud/cloud-mass-extinction';
import { test } from '../harness';

const LAYERS: readonly CloudExtinctionLayer[] = [
  {
    lowerAltitudeM: 0, upperAltitudeM: 100,
    liquidPerMByCell: [1e-5, 2e-5, 3e-5, 4e-5],
    icePerMByCell: [5e-5, 6e-5, 7e-5, 8e-5],
  },
  {
    lowerAltitudeM: 100, upperAltitudeM: 300,
    liquidPerMByCell: [11e-5, 12e-5, 13e-5, 14e-5],
    icePerMByCell: [15e-5, 16e-5, 17e-5, 18e-5],
  },
];

export function register(): void {
  test('cloud optical volume frame: layer-major RG channels preserve independent cell positions', () => {
    const result = cloudOpticalVolumeFrameFromExtinction(2, 2, [0, 100, 300], LAYERS);
    assert.deepEqual(result.layerEdgesM, new Float32Array([0, 100, 300]));
    assert.deepEqual(result.liquidExtinctionPerM, new Float32Array([
      1e-5, 2e-5, 3e-5, 4e-5, 11e-5, 12e-5, 13e-5, 14e-5,
    ]));
    assert.deepEqual(result.iceExtinctionPerM, new Float32Array([
      5e-5, 6e-5, 7e-5, 8e-5, 15e-5, 16e-5, 17e-5, 18e-5,
    ]));
  });

  test('cloud optical volume frame: rejects dimensions, layer edges, cell counts, and invalid extinction', () => {
    assert.throws(() => cloudOpticalVolumeFrameFromExtinction(0, 2, [0, 100], [LAYERS[0]!]), RangeError);
    assert.throws(() => cloudOpticalVolumeFrameFromExtinction(2, 2, [0, 100], LAYERS), RangeError);
    assert.throws(() => cloudOpticalVolumeFrameFromExtinction(2, 2, [0, 100, 100], LAYERS), RangeError);
    assert.throws(() => cloudOpticalVolumeFrameFromExtinction(2, 2, [0, 100, 300], [
      { ...LAYERS[0]!, upperAltitudeM: 99 }, LAYERS[1]!,
    ]), RangeError);
    assert.throws(() => cloudOpticalVolumeFrameFromExtinction(2, 2, [0, 100, 300], [
      { ...LAYERS[0]!, liquidPerMByCell: [1e-5] }, LAYERS[1]!,
    ]), RangeError);
    assert.throws(() => cloudOpticalVolumeFrameFromExtinction(2, 2, [0, 100, 300], [
      { ...LAYERS[0]!, icePerMByCell: [0, 0, Number.NaN, 0] }, LAYERS[1]!,
    ]), RangeError);
    assert.throws(() => cloudOpticalVolumeFrameFromExtinction(2, 2, [0, 100, 300], [
      { ...LAYERS[0]!, liquidPerMByCell: [0, 0, -1, 0] }, LAYERS[1]!,
    ]), RangeError);
    assert.throws(() => cloudOpticalVolumeFrameFromExtinction(2, 2, [0, 100, 300], [
      { ...LAYERS[0]!, liquidPerMByCell: [Number.MIN_VALUE, 0, 0, 0] }, LAYERS[1]!,
    ]), RangeError);
    assert.throws(() => cloudOpticalVolumeFrameFromExtinction(1, 1, [0, 1, 1 + 1e-8], [
      { lowerAltitudeM: 0, upperAltitudeM: 1, liquidPerMByCell: [0], icePerMByCell: [0] },
      { lowerAltitudeM: 1, upperAltitudeM: 1 + 1e-8, liquidPerMByCell: [0], icePerMByCell: [0] },
    ]), RangeError);
  });

  test('cloud optical volume frame: sampled event deposits by phase into the matching RG layer slices', () => {
    const sphereRadiusM = 6_371_000;
    const event = sampleConvectiveCloudEvents({
      seed: 17, birthIntervalSeconds: 86_400, historyHorizonSeconds: 10_000,
      maximumOmittedMassKgM2: 1, maxEventCount: 8, timeSeconds: 7_200,
      cells: [{
        id: 'optical-volume-cell', supplySourceId: 'optical-volume-source',
        convectivePotential: 1, upperRelativeHumidity: 0.8,
        liquidSupplyRateKgM2S: 1e-5, convectiveDurationSeconds: 3_600,
        sourcePosition: { directionUnitVector: v3(1, 0, 0), geometricHeightM: 1_000 },
        iceReleaseHeightM: 6_000,
      }],
    }).events[0];
    assert.ok(event);
    const material = reconstructCloudEventMaterialCohorts(
      event, sphereRadiusM, 60,
      (directionUnitVector) => {
        const horizontalMagnitude = Math.hypot(directionUnitVector.x, directionUnitVector.y);
        const east = horizontalMagnitude > 1e-12
          ? v3(-directionUnitVector.y / horizontalMagnitude, directionUnitVector.x / horizontalMagnitude, 0)
          : v3(0, 1, 0);
        return { tangentVelocityMPerS: v3(east.x * 0.2, east.y * 0.2, east.z * 0.2), verticalVelocityMPerS: 0 };
      }, 8,
    );
    const sourceAreaM2 = 4_000_000;
    const footprintAreaM2 = Math.PI * 4_000 ** 2;
    const width = 64;
    const height = 64;
    const footprintGrid = {
      originEastM: -8_000, originNorthM: -8_000,
      cellWidthM: 250, cellHeightM: 250, width, height,
    };
    const massGrid: CloudMassGrid = {
      cells: Array.from({ length: width * height }, () => ({ areaM2: 250 ** 2 })),
      layerEdgesM: [0, 3_000, 9_000],
    };
    const circle = {
      isotropicRadiusM: Math.sqrt(footprintAreaM2 / Math.PI), elongationVectorsM: [],
    };
    const deposition = depositCloudEventMaterialCohorts(
      material, sourceAreaM2,
      {
        parentLiquid: circle,
        releasedIceCohorts: material.releasedIceCohorts.map(({ cohortIndex }) => ({
          cohortIndex, shape: circle,
        })),
      },
      {
        centerDirectionUnitVector: v3(1, 0, 0),
        eastUnitVector: v3(0, 1, 0), northUnitVector: v3(0, 0, 1),
        sphereRadiusM, maxAngularDistanceRad: 0.01,
      }, footprintGrid, massGrid,
    );
    const extinction = extinctionFromCloudMass(deposition, [0, 1].map(() => ({
      liquidEffectiveRadiusM: 10e-6, iceEffectiveRadiusM: 30e-6, iceExtinctionEfficiency: 2,
    })));
    const result = cloudOpticalVolumeFrameFromExtinction(
      width, height, massGrid.layerEdgesM, extinction,
    );
    const planeSize = width * height;
    const liquidMassKg = deposition.columnsByLayer.reduce((total, layer) => total
      + layer.liquidKgM2ByCell.reduce((mass, column, index) => mass + column * massGrid.cells[index]!.areaM2, 0), 0);
    const iceMassKg = deposition.columnsByLayer.reduce((total, layer) => total
      + layer.iceKgM2ByCell.reduce((mass, column, index) => mass + column * massGrid.cells[index]!.areaM2, 0), 0);
    assert.ok(Math.abs(liquidMassKg + deposition.unassignedMassKgByPhase.liquid
      - event.mass.liquidKgM2 * sourceAreaM2) < 1e-8);
    assert.ok(Math.abs(iceMassKg + deposition.unassignedMassKgByPhase.ice
      - event.iceRelease.remainingKgM2 * sourceAreaM2) < 1e-8);
    assert.ok(result.liquidExtinctionPerM.subarray(0, planeSize).some((value) => value > 0));
    assert.equal(result.iceExtinctionPerM.subarray(0, planeSize).some((value) => value > 0), false);
    assert.equal(result.liquidExtinctionPerM.subarray(planeSize).some((value) => value > 0), false);
    assert.ok(result.iceExtinctionPerM.subarray(planeSize).some((value) => value > 0));
  });
}
