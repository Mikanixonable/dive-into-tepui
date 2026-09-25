// RG32Fの相別・高度層別消散場を、実際のTSL DataArrayTexture標本で表示する合成ケース。
import * as THREE from 'three/webgpu';
import { float, uv, vec2, vec3 } from 'three/tsl';
import {
  CloudOpticalVolume, sampleCloudOpticalVolumeNode, type CloudOpticalVolumeData,
} from '../../src/render/cloud/cloud-optical-volume';
import { labCamera, VIEW_HEIGHT, VIEW_WIDTH } from './lab-case';
import type { CaseBuilder, LabCase } from './lab-case';

const WIDTH = 32;
const HEIGHT = 32;
const LAYER_EDGES_M = new Float32Array([0, 1_000, 3_000, 7_000, 12_000]);
const EXTINCTION_SCALE = 100;
const PROBE_SHOT = 'cloud-optical-volume-gpu-oracle';
const PROBE_ROWS = 3;
const PROBE_COLUMNS = 4;
const PROBE_UVS = [[1.5 / WIDTH, 16.5 / HEIGHT], [4 / WIDTH, 16.25 / HEIGHT], [0, 0.5]] as const;

function probeAltitudes(): readonly number[] {
  const epsilonM = 0.1;
  return [
    LAYER_EDGES_M[0]!, LAYER_EDGES_M[0]! + epsilonM,
    LAYER_EDGES_M[1]! - epsilonM, LAYER_EDGES_M[1]!,
    LAYER_EDGES_M[2]! - epsilonM, LAYER_EDGES_M[2]!,
    LAYER_EDGES_M[3]! - epsilonM, LAYER_EDGES_M[3]!,
    LAYER_EDGES_M[4]!,
  ];
}

function worldPointForPixelCenter(column: number, row: number): THREE.Vector3 {
  const distance = VIEW_HEIGHT * 0.85;
  const fovFactor = Math.tan(THREE.MathUtils.degToRad(50) / 2) * 2 * distance;
  const pixelX = (column + 0.5) * VIEW_WIDTH / PROBE_COLUMNS;
  const pixelY = (row + 0.5) * VIEW_HEIGHT / PROBE_ROWS;
  return new THREE.Vector3(
    (pixelX / VIEW_WIDTH * 2 - 1) * fovFactor * VIEW_WIDTH / VIEW_HEIGHT / 2,
    (1 - pixelY / VIEW_HEIGHT * 2) * fovFactor / 2,
    -distance,
  );
}

function syntheticVolumeData(): CloudOpticalVolumeData {
  const layerCount = LAYER_EDGES_M.length - 1;
  const liquid = new Float32Array(WIDTH * HEIGHT * layerCount);
  const ice = new Float32Array(liquid.length);
  for (let layer = 0; layer < layerCount; layer += 1) {
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        const index = layer * WIDTH * HEIGHT + y * WIDTH + x;
        const east = (x + 0.5) / WIDTH;
        const north = (y + 0.5) / HEIGHT;
        // 相と層が区別できる既知場。低層は液水の縦縞、高層は氷の斜め帯。
        liquid[index] = layer < 2 && Math.sin(east * Math.PI * 8) > 0
          ? (0.001 + 0.001 * north) * (layer + 1) : 0.0005 * (layer + 1);
        ice[index] = layer >= 2 && Math.sin((east + north) * Math.PI * 5) > 0.25
          ? 0.0015 * (layer - 1) : 0.0005 * (layer + 1);
      }
    }
  }
  return {
    width: WIDTH,
    height: HEIGHT,
    layerEdgesM: LAYER_EDGES_M,
    liquidExtinctionPerM: liquid,
    iceExtinctionPerM: ice,
  };
}

export const CLOUD_OPTICAL_VOLUME_CASE: CaseBuilder = (): LabCase => {
  const volume = new CloudOpticalVolume(syntheticVolumeData());
  const camera = labCamera();
  const panelSize = VIEW_HEIGHT * 0.34;
  const panelGap = panelSize * 0.16;
  const objects: THREE.Object3D[] = [];
  for (let layer = 0; layer < volume.depth; layer += 1) {
    const material = new THREE.MeshBasicNodeMaterial();
    const sample = sampleCloudOpticalVolumeNode(volume.texture, uv(), float(layer));
    material.colorNode = vec3(
      sample.liquidExtinctionPerM.mul(EXTINCTION_SCALE),
      float(0),
      sample.iceExtinctionPerM.mul(EXTINCTION_SCALE),
    );
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(panelSize, panelSize), material);
    mesh.userData.ownsGeometry = true;
    mesh.userData.ownsMaterial = true;
    const column = layer % 2;
    const row = Math.floor(layer / 2);
    mesh.position.set(
      (column === 0 ? -1 : 1) * (panelSize + panelGap) * 0.5,
      (row === 0 ? 1 : -1) * (panelSize + panelGap) * 0.5,
      -VIEW_HEIGHT * 0.85,
    );
    objects.push(mesh);
  }
  const patchWorldSize = VIEW_HEIGHT / PROBE_ROWS * Math.tan(THREE.MathUtils.degToRad(50) / 2) * 2 * 0.7;
  const altitudes = probeAltitudes();
  for (let probe = 0; probe < altitudes.length; probe += 1) {
    const altitude = altitudes[probe]!;
    const layer = layerIndexAt(altitude);
    const row = Math.floor(probe / PROBE_COLUMNS);
    const column = probe % PROBE_COLUMNS;
    const [u, v] = PROBE_UVS[probe % PROBE_UVS.length]!;
    const sample = sampleCloudOpticalVolumeNode(volume.texture, vec2(u, v), float(layer));
    const material = new THREE.MeshBasicNodeMaterial();
    material.colorNode = vec3(
      sample.liquidExtinctionPerM.mul(EXTINCTION_SCALE),
      float(0),
      sample.iceExtinctionPerM.mul(EXTINCTION_SCALE),
    );
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(patchWorldSize, patchWorldSize), material);
    mesh.userData.ownsGeometry = true;
    mesh.userData.ownsMaterial = true;
    mesh.position.copy(worldPointForPixelCenter(column, row));
    objects.push(mesh);
  }
  const referenceMaterial = new THREE.MeshBasicNodeMaterial();
  referenceMaterial.colorNode = vec3(float(0.4), float(0), float(0.4));
  const reference = new THREE.Mesh(new THREE.PlaneGeometry(patchWorldSize, patchWorldSize), referenceMaterial);
  reference.userData.ownsGeometry = true;
  reference.userData.ownsMaterial = true;
  reference.position.copy(worldPointForPixelCenter(3, 2));
  reference.position.z -= 0.01;
  objects.push(reference);
  return {
    objects,
    camera,
    shots: {
      'cloud-optical-volume': { view: {} },
      [PROBE_SHOT]: { view: {}, graphics: { filmLut: 'none', antialias: 0 } },
    },
    dispose: () => volume.dispose(),
  };
};

function layerIndexAt(altitudeM: number): number {
  for (let layer = 0; layer < LAYER_EDGES_M.length - 1; layer += 1) {
    if (altitudeM < LAYER_EDGES_M[layer + 1]!) return layer;
  }
  return LAYER_EDGES_M.length - 2;
}
