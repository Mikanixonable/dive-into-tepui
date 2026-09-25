// C9の固定二層雲を、実際のWebGPUレイ積分結果として既知の画面領域へ描く診断ケース。
import * as THREE from 'three/webgpu';
import { float, vec2, vec3 } from 'three/tsl';
import { CloudOpticalVolume } from '../../src/render/cloud/cloud-optical-volume';
import { integrateCloudOpticalVolumeRayNode } from '../../src/render/cloud/cloud-optical-ray';
import { labCamera, VIEW_HEIGHT, VIEW_WIDTH } from './lab-case';
import type { CaseBuilder, LabCase } from './lab-case';

const WIDTH = 4;
const HEIGHT = 4;
const GRID_SPAN_M = 20_000;
const LAYER_EDGES_M = new Float32Array([0, 1_000, 3_000, 6_000, 8_000]);
const RAY_COUNT = 2;
const VALUE_COUNT = 4;
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
    phase.fill(extinction, layer * WIDTH * HEIGHT, (layer + 1) * WIDTH * HEIGHT);
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

export const CLOUD_OPTICAL_RAY_CASE: CaseBuilder = (): LabCase => {
  const volume = diagnosticVolume();
  const camera = labCamera();
  const distanceM = VIEW_HEIGHT * 0.8;
  const tileHeightM = 2 * Math.tan(THREE.MathUtils.degToRad(50) / 2) * distanceM / VALUE_COUNT;
  const tileWidthM = tileHeightM * VIEW_WIDTH / VIEW_HEIGHT * VALUE_COUNT / RAY_COUNT;
  const objects: THREE.Object3D[] = [];

  for (let rayIndex = 0; rayIndex < RAY_COUNT; rayIndex += 1) {
    const ray = integrateCloudOpticalVolumeRayNode(volume.texture, LAYER_EDGES_M, {
      originUv: vec2(0.25, 0.5),
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
};
