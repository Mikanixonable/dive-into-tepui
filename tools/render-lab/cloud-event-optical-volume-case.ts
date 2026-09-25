// 固定seedの対流イベントを、質量保存・二相消散を通じたRG32F textureとして表示する診断ケース。
import * as THREE from 'three/webgpu';
import { float, uv, vec3 } from 'three/tsl';
import { v3 } from '../../src/math/vec3';
import { sampleConvectiveCloudEvents } from '../../src/game/cloud/cloud-events';
import { reconstructCloudEventMaterialCohorts } from '../../src/game/cloud/cloud-event-transport';
import { depositCloudEventMaterialCohorts } from '../../src/game/cloud/cloud-event-local-deposition';
import { extinctionFromCloudMass } from '../../src/game/cloud/cloud-mass-extinction';
import { cloudOpticalVolumeFrameFromExtinction } from '../../src/game/cloud/cloud-optical-volume-frame';
import {
  CloudOpticalVolume, sampleCloudOpticalVolumeNode, type CloudOpticalVolumeStorageFormat,
} from '../../src/render/cloud/cloud-optical-volume';
import type { CloudOpticalVolumeData } from '../../src/render/cloud/cloud-optical-volume';
import { labCamera, VIEW_HEIGHT } from './lab-case';
import type { CaseBuilder, LabCase } from './lab-case';

const SEED = 17;
const TIME_SECONDS = 7_200;
const SPHERE_RADIUS_M = 6_371_000;
const SOURCE_AREA_M2 = 4_000_000;
const FOOTPRINT_AREA_M2 = Math.PI * 4_000 ** 2;
const WIDTH = 64;
const HEIGHT = 64;
const CELL_WIDTH_M = 250;
const CELL_HEIGHT_M = 250;
const LAYER_EDGES_M = [0, 3_000, 9_000] as const;
const OPTICAL_VISUAL_GAIN = 120_000;

export function sampleEventOpticalVolume(): CloudOpticalVolumeData {
  const event = sampleConvectiveCloudEvents({
    seed: SEED,
    birthIntervalSeconds: 86_400,
    historyHorizonSeconds: 10_000,
    maximumOmittedMassKgM2: 1,
    maxEventCount: 8,
    timeSeconds: TIME_SECONDS,
    cells: [{
      id: 'event-optical-volume-cell',
      supplySourceId: 'event-optical-volume-source',
      convectivePotential: 1,
      upperRelativeHumidity: 0.8,
      liquidSupplyRateKgM2S: 1e-5,
      convectiveDurationSeconds: 3_600,
      sourcePosition: { directionUnitVector: v3(1, 0, 0), geometricHeightM: 1_000 },
      iceReleaseHeightM: 6_000,
    }],
  }).events[0];
  if (event === undefined) throw new Error('diagnostic seed did not sample a cloud event');

  const material = reconstructCloudEventMaterialCohorts(
    event,
    SPHERE_RADIUS_M,
    60,
    (directionUnitVector) => {
      const horizontalMagnitude = Math.hypot(directionUnitVector.x, directionUnitVector.y);
      const east = horizontalMagnitude > 1e-12
        ? v3(-directionUnitVector.y / horizontalMagnitude, directionUnitVector.x / horizontalMagnitude, 0)
        : v3(0, 1, 0);
      return {
        tangentVelocityMPerS: v3(east.x * 0.2, east.y * 0.2, east.z * 0.2),
        verticalVelocityMPerS: 0,
      };
    },
    8,
  );

  const footprintGrid = {
    originEastM: -8_000,
    originNorthM: -8_000,
    cellWidthM: CELL_WIDTH_M,
    cellHeightM: CELL_HEIGHT_M,
    width: WIDTH,
    height: HEIGHT,
  };
  const massGrid = {
    cells: Array.from({ length: WIDTH * HEIGHT }, () => ({ areaM2: CELL_WIDTH_M * CELL_HEIGHT_M })),
    layerEdgesM: LAYER_EDGES_M,
  };
  const deposition = depositCloudEventMaterialCohorts(
    material,
    SOURCE_AREA_M2,
    {
      parentLiquidM2: FOOTPRINT_AREA_M2,
      releasedIceCohorts: material.releasedIceCohorts.map(({ cohortIndex }) => ({
        cohortIndex,
        areaM2: FOOTPRINT_AREA_M2,
      })),
    },
    {
      centerDirectionUnitVector: v3(1, 0, 0),
      eastUnitVector: v3(0, 1, 0),
      northUnitVector: v3(0, 0, 1),
      sphereRadiusM: SPHERE_RADIUS_M,
      maxAngularDistanceRad: 0.01,
    },
    footprintGrid,
    massGrid,
  );
  const extinction = extinctionFromCloudMass(deposition, [0, 1].map(() => ({
    liquidEffectiveRadiusM: 10e-6,
    iceEffectiveRadiusM: 30e-6,
    iceExtinctionEfficiency: 2,
  })));
  return cloudOpticalVolumeFrameFromExtinction(WIDTH, HEIGHT, LAYER_EDGES_M, extinction);
}

export function cloudEventOpticalVolumeCase(
  storageFormat: CloudOpticalVolumeStorageFormat = 'rg32f',
): CaseBuilder {
  return (): LabCase => {
    const volume = new CloudOpticalVolume(sampleEventOpticalVolume(), { storageFormat });
    const camera = labCamera();
    const panelSize = VIEW_HEIGHT * 0.56;
    const panelGap = panelSize * 0.12;
    const objects: THREE.Object3D[] = [];
    for (let layer = 0; layer < volume.depth; layer += 1) {
      const sample = sampleCloudOpticalVolumeNode(volume.texture, uv(), float(layer));
      const liquid = sample.liquidExtinctionPerM.mul(OPTICAL_VISUAL_GAIN);
      const ice = sample.iceExtinctionPerM.mul(OPTICAL_VISUAL_GAIN);
      const material = new THREE.MeshBasicNodeMaterial();
      material.colorNode = vec3(
        liquid.add(ice.mul(0.1)),
        liquid.mul(0.1).add(ice.mul(0.7)),
        ice,
      );
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(panelSize, panelSize), material);
      mesh.userData.ownsGeometry = true;
      mesh.userData.ownsMaterial = true;
      mesh.position.set(
        (layer === 0 ? -1 : 1) * (panelSize + panelGap) * 0.5,
        0,
        -VIEW_HEIGHT * 0.85,
      );
      objects.push(mesh);
    }
    return { objects, camera, dispose: () => volume.dispose() };
  };
}

export const CLOUD_EVENT_OPTICAL_VOLUME_CASE: CaseBuilder = cloudEventOpticalVolumeCase();
export const CLOUD_EVENT_OPTICAL_VOLUME_RG16F_CASE: CaseBuilder = cloudEventOpticalVolumeCase('rg16f');
