// C9の固定二層雲を、実際のWebGPUレイ積分結果として既知の画面領域へ描く診断ケース。
import * as THREE from 'three/webgpu';
import { float, vec2, vec3 } from 'three/tsl';
import { CloudOpticalVolume } from '../../src/render/cloud/cloud-optical-volume';
import { integrateCloudOpticalVolumeRayNode } from '../../src/render/cloud/cloud-optical-ray';
import { labCamera, VIEW_HEIGHT, VIEW_WIDTH } from './lab-case';
import type { CaseBuilder, LabCase } from './lab-case';

const FOOTPRINT_RADIUS_M = 10_000;
const CELL_SIZE_M = 250;
const WIDTH = (2 * FOOTPRINT_RADIUS_M) / CELL_SIZE_M;
const HEIGHT = WIDTH;
const GRID_SPAN_M = 20_000;
const LAYER_EDGES_M = new Float32Array([0, 1_000, 3_000, 6_000, 8_000]);
const RAY_COUNT = 2;
const VALUE_COUNT = 4;
const CALIBRATION_VALUES = [0.1, 0.3, 0.5, 0.7, 0.9] as const;
const SHOT_NAME = 'cloud-optical-ray-c9-gpu';
const OUTPUTS = ['liquidTau', 'iceTau', 'totalTau', 'transmittance'] as const;

function diagnosticVolume(): CloudOpticalVolume {
  const texelCount = WIDTH * HEIGHT * (LAYER_EDGES_M.length - 1);
  const liquid = new Float32Array(texelCount);
  const ice = new Float32Array(texelCount);
  for (let layer = 0; layer < LAYER_EDGES_M.length - 1; layer += 1) {
    const extinction = LAYER_EDGES_M[layer] === 1_000 ? 2e-4
      : LAYER_EDGES_M[layer] === 6_000 ? 1e-4 : 0;
    const phase = LAYER_EDGES_M[layer] === 6_000 ? ice : liquid;
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        const eastM = -FOOTPRINT_RADIUS_M + (x + 0.5) * CELL_SIZE_M;
        const northM = -FOOTPRINT_RADIUS_M + (y + 0.5) * CELL_SIZE_M;
        if (Math.hypot(eastM, northM) <= FOOTPRINT_RADIUS_M) {
          phase[layer * WIDTH * HEIGHT + y * WIDTH + x] = extinction;
        }
      }
    }
  }
  const raySupportMarginM = Math.SQRT2 * CELL_SIZE_M / 2;
  if (8_000 > FOOTPRINT_RADIUS_M - raySupportMarginM) {
    throw new RangeError('the entire C9 diagnostic ray must remain inside the disk with bilinear support');
  }
  return new CloudOpticalVolume({
    width: WIDTH,
    height: HEIGHT,
    layerEdgesM: LAYER_EDGES_M,
    liquidExtinctionPerM: liquid,
    iceExtinctionPerM: ice,
  });
}

function tileCenter(column: number, row: number, distanceM: number): THREE.Vector3 {
  const halfHeight = Math.tan(THREE.MathUtils.degToRad(50) / 2) * distanceM;
  const halfWidth = halfHeight * VIEW_WIDTH / VIEW_HEIGHT;
  return new THREE.Vector3(
    ((column + 0.5) / RAY_COUNT * 2 - 1) * halfWidth,
    (1 - (row + 0.5) / VALUE_COUNT * 2) * halfHeight,
    -distanceM,
  );
}

function pixelCenterOnPlane(x: number, y: number, distanceM: number): THREE.Vector3 {
  const halfHeight = Math.tan(THREE.MathUtils.degToRad(50) / 2) * distanceM;
  const halfWidth = halfHeight * VIEW_WIDTH / VIEW_HEIGHT;
  return new THREE.Vector3((2 * x / VIEW_WIDTH - 1) * halfWidth,
    (1 - 2 * y / VIEW_HEIGHT) * halfHeight, -distanceM);
}

export const CLOUD_OPTICAL_RAY_CASE: CaseBuilder = (): LabCase => {
  const volume = diagnosticVolume();
  const camera = labCamera();
  const distanceM = VIEW_HEIGHT * 0.8;
  const tileHeightM = 2 * Math.tan(THREE.MathUtils.degToRad(50) / 2) * distanceM / VALUE_COUNT;
  const tileWidthM = tileHeightM * VIEW_WIDTH / VIEW_HEIGHT * VALUE_COUNT / RAY_COUNT;
  const objects: THREE.Object3D[] = [];

  for (let rayIndex = 0; rayIndex < RAY_COUNT; rayIndex += 1) {
    const ray = integrateCloudOpticalVolumeRayNode(volume.texture, LAYER_EDGES_M, {
      originUv: vec2(0.5, 0.5),
      gridSpanEastM: GRID_SPAN_M,
      gridSpanNorthM: GRID_SPAN_M,
      uvDeltaPerAltitudeM: rayIndex === 0 ? vec2(0, 0) : vec2(1 / GRID_SPAN_M, 0),
      startAltitudeM: float(0),
      endAltitudeM: float(8_000),
    });
    for (let outputIndex = 0; outputIndex < VALUE_COUNT; outputIndex += 1) {
      const value = outputIndex === 0 ? ray.x
        : outputIndex === 1 ? ray.y
          : outputIndex === 2 ? ray.z : ray.w;
      const material = new THREE.MeshBasicNodeMaterial();
      material.colorNode = vec3(value, value, value);
      material.toneMapped = false;
      const tile = new THREE.Mesh(new THREE.PlaneGeometry(tileWidthM, tileHeightM), material);
      tile.userData.ownsGeometry = true;
      tile.userData.ownsMaterial = true;
      tile.position.copy(tileCenter(rayIndex, outputIndex, distanceM));
      objects.push(tile);
    }
  }

  const calibrationDistanceM = distanceM - 1;
  const calibrationWidthM = 16 * (2 * Math.tan(THREE.MathUtils.degToRad(50) / 2)
    * calibrationDistanceM * VIEW_WIDTH / VIEW_HEIGHT) / VIEW_WIDTH;
  const calibrationHeightM = 12 * (2 * Math.tan(THREE.MathUtils.degToRad(50) / 2)
    * calibrationDistanceM) / VIEW_HEIGHT;
  CALIBRATION_VALUES.forEach((value, index) => {
    const material = new THREE.MeshBasicNodeMaterial();
    material.colorNode = vec3(float(value), float(value), float(value));
    material.toneMapped = false;
    const patch = new THREE.Mesh(new THREE.PlaneGeometry(calibrationWidthM, calibrationHeightM), material);
    patch.userData.ownsGeometry = true;
    patch.userData.ownsMaterial = true;
    patch.position.copy(pixelCenterOnPlane(22, 18 + index * 16, calibrationDistanceM));
    objects.push(patch);
  });

  return {
    objects,
    camera,
    shots: { [SHOT_NAME]: { view: {}, graphics: { filmLut: 'none', antialias: 0 } } },
    dispose: () => volume.dispose(),
  };
};

export const CLOUD_OPTICAL_RAY_PROBE = {
  caseName: 'cloud-optical-ray-c9',
  shotName: SHOT_NAME,
  width: VIEW_WIDTH,
  height: VIEW_HEIGHT,
  rayNames: ['vertical', '45deg'] as const,
  outputNames: OUTPUTS,
  calibrationValues: CALIBRATION_VALUES,
  footprintRadiusM: FOOTPRINT_RADIUS_M,
  cellSizeM: CELL_SIZE_M,
};
