// 固定seedの対流イベントを、質量保存・二相消散を通じたRG32F textureとして表示する診断ケース。
import * as THREE from 'three/webgpu';
import { float, uv, vec3 } from 'three/tsl';
import { v3 } from '../../src/math/vec3';
import { sampleConvectiveCloudEvents } from '../../src/game/cloud/cloud-events';
import { reconstructCloudEventMaterialCohorts, type CloudEventWindAt } from '../../src/game/cloud/cloud-event-transport';
import { createCloudEnvironmentProfile } from '../../src/game/cloud/cloud-environment';
import { deriveCloudEventAreas } from '../../src/game/cloud/cloud-event-area-closure';
import { depositCloudEventMaterialCohorts } from '../../src/game/cloud/cloud-event-local-deposition';
import { extinctionFromCloudMass } from '../../src/game/cloud/cloud-mass-extinction';
import { cloudOpticalVolumeFrameFromExtinction } from '../../src/game/cloud/cloud-optical-volume-frame';
import {
  CloudOpticalVolume, encodeCloudOpticalVolumeHalfFloat, sampleCloudOpticalVolumeNode,
  type CloudOpticalVolumeStorageFormat,
} from '../../src/render/cloud/cloud-optical-volume';
import type { CloudOpticalVolumeData } from '../../src/render/cloud/cloud-optical-volume';
import { labCamera, VIEW_HEIGHT } from './lab-case';
import type { CaseBuilder, LabCase } from './lab-case';

const SEED = 17;
const TIME_SECONDS = 7_200;
const SPHERE_RADIUS_M = 6_371_000;
const WIDTH = 64;
const HEIGHT = 64;
const CELL_WIDTH_M = 250;
const CELL_HEIGHT_M = 250;
const LAYER_EDGES_M = [0, 3_000, 9_000] as const;
const OPTICAL_VISUAL_GAIN = 120_000;
const READBACK_ROW_ALIGNMENT_BYTES = 256;

function alignedReadbackRowBytes(width: number, bytesPerTexel: number): number {
  const unpaddedRowBytes = width * bytesPerTexel;
  return Math.ceil(unpaddedRowBytes / READBACK_ROW_ALIGNMENT_BYTES) * READBACK_ROW_ALIGNMENT_BYTES;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const input = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(input).set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function gpuTextureReadbackReport(
  volume: CloudOpticalVolume,
  source: CloudOpticalVolumeData,
  readLayer: (
    texture: THREE.Texture, width: number, height: number, layer: number,
  ) => Promise<{ readonly data: ArrayBufferView; readonly format: string }>,
): Promise<unknown> {
  const bytesPerChannel = volume.storageFormat === 'rg16f' ? 2 : 4;
  const bytesPerTexel = bytesPerChannel * 2;
  const expectedFormat = volume.storageFormat === 'rg16f' ? 'rg16float' : 'rg32float';
  const expected = volume.storageFormat === 'rg16f'
    ? encodeCloudOpticalVolumeHalfFloat(source.liquidExtinctionPerM, source.iceExtinctionPerM).interleaved
    : new Float32Array(source.liquidExtinctionPerM.length * 2);
  if (expected instanceof Float32Array) {
    for (let index = 0; index < source.liquidExtinctionPerM.length; index += 1) {
      expected[index * 2] = source.liquidExtinctionPerM[index]!;
      expected[index * 2 + 1] = source.iceExtinctionPerM[index]!;
    }
  }
  const rowBytes = volume.width * bytesPerTexel;
  const rowPitchBytes = alignedReadbackRowBytes(volume.width, bytesPerTexel);
  const usefulLayerBytes = rowBytes * volume.height;
  const expectedLayerBytes = rowPitchBytes * (volume.height - 1) + rowBytes;
  const layers = [];
  let rawReturnedBytes = 0;
  for (let layer = 0; layer < volume.depth; layer += 1) {
    const readback = await readLayer(volume.texture, volume.width, volume.height, layer);
    const raw = readback.data;
    const actualFormat = readback.format;
    if (actualFormat !== expectedFormat) {
      throw new Error(`GPU texture format mismatch: expected ${expectedFormat}, got ${actualFormat}`);
    }
    if (raw.byteLength !== expectedLayerBytes) {
      throw new Error(`unexpected GPU readback size ${raw.byteLength}; expected ${expectedLayerBytes}`);
    }
    const packedBytes = new Uint8Array(usefulLayerBytes);
    const actualBytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    for (let y = 0; y < volume.height; y += 1) {
      packedBytes.set(actualBytes.subarray(y * rowPitchBytes, y * rowPitchBytes + rowBytes), y * rowBytes);
    }
    const actual = volume.storageFormat === 'rg16f'
      ? new Uint16Array(packedBytes.buffer)
      : new Float32Array(packedBytes.buffer);
    let exactBitMismatchCount = 0;
    let maximumAbsoluteValueError = 0;
    const phaseSummary = {
      liquid: { sampleCount: 0, positiveSourceCount: 0, zeroRoundedPositiveCount: 0, exactBitMismatchCount: 0,
        maximumAbsoluteValueError: 0 },
      ice: { sampleCount: 0, positiveSourceCount: 0, zeroRoundedPositiveCount: 0, exactBitMismatchCount: 0,
        maximumAbsoluteValueError: 0 },
    };
    for (let y = 0; y < volume.height; y += 1) {
      for (let x = 0; x < volume.width; x += 1) {
        const texel = layer * volume.width * volume.height + y * volume.width + x;
        for (let phase = 0; phase < 2; phase += 1) {
          const item = phase === 0 ? phaseSummary.liquid : phaseSummary.ice;
          const actualChannel = (y * volume.width + x) * 2 + phase;
          const expectedChannel = texel * 2 + phase;
          const actualValue = volume.storageFormat === 'rg16f'
            ? THREE.DataUtils.fromHalfFloat(actual[actualChannel]!)
            : actual[actualChannel]!;
          const expectedValue = volume.storageFormat === 'rg16f'
            ? THREE.DataUtils.fromHalfFloat(expected[expectedChannel]!)
            : expected[expectedChannel]!;
          if (!Number.isFinite(actualValue) || !Number.isFinite(expectedValue)) {
            throw new Error(`non-finite raw texture sample at layer ${layer}, texel ${y * volume.width + x}, phase ${phase}`);
          }
          const sourceValue = phase === 0
            ? source.liquidExtinctionPerM[texel]!
            : source.iceExtinctionPerM[texel]!;
          const matchesBits = actual[actualChannel] === expected[expectedChannel];
          const absoluteError = Math.abs(actualValue - expectedValue);
          item.sampleCount += 1;
          if (sourceValue > 0) item.positiveSourceCount += 1;
          if (sourceValue > 0 && volume.storageFormat === 'rg16f' && actualValue === 0) {
            item.zeroRoundedPositiveCount += 1;
          }
          if (!matchesBits) {
            item.exactBitMismatchCount += 1;
            exactBitMismatchCount += 1;
          }
          item.maximumAbsoluteValueError = Math.max(item.maximumAbsoluteValueError, absoluteError);
          maximumAbsoluteValueError = Math.max(maximumAbsoluteValueError, absoluteError);
        }
      }
    }
    rawReturnedBytes += raw.byteLength;
    layers.push({
      layer,
      actualBackendFormat: actualFormat,
      rowPitchBytes,
      usefulBytes: usefulLayerBytes,
      returnedBytes: raw.byteLength,
      packedReadbackSha256: await sha256(packedBytes),
      exactBitMismatchCount,
      maximumAbsoluteValueError,
      phases: phaseSummary,
    });
  }
  return {
    storageFormat: volume.storageFormat,
    actualBackendFormat: expectedFormat,
    width: volume.width,
    height: volume.height,
    depth: volume.depth,
    bytesPerTexel,
    rowAlignmentBytes: READBACK_ROW_ALIGNMENT_BYTES,
    expectedBytesPerLayer: expectedLayerBytes,
    usefulBytesPerLayer: usefulLayerBytes,
    totalReturnedBytes: rawReturnedBytes,
    totalUsefulBytes: usefulLayerBytes * volume.depth,
    zeroRoundedCpuDiagnosticsByPhase: volume.halfFloatDiagnosticsByPhase,
    comparison: 'raw GPU texel bits versus CPU upload bits; no filtering, ray integration, or framebuffer color conversion',
    layers,
  };
}

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

  const windAt: CloudEventWindAt = (directionUnitVector) => {
    const horizontalMagnitude = Math.hypot(directionUnitVector.x, directionUnitVector.y);
    const east = horizontalMagnitude > 1e-12
      ? v3(-directionUnitVector.y / horizontalMagnitude, directionUnitVector.x / horizontalMagnitude, 0)
      : v3(0, 1, 0);
    return {
      tangentVelocityMPerS: v3(east.x * 0.2, east.y * 0.2, east.z * 0.2),
      verticalVelocityMPerS: 0,
    };
  };
  const material = reconstructCloudEventMaterialCohorts(
    event,
    SPHERE_RADIUS_M,
    60,
    windAt,
    8,
  );

  // 面積閉包に渡す環境列。CAPE と平衡高度の安定度が上昇コア断面積と
  // 滞留時間で成長する footprint を決める。
  const environment = createCloudEnvironmentProfile({
    levels: [
      { heightM: 0, temperatureK: 298, pressurePa: 100_000, waterVaporSpecificHumidityKgPerKg: 0.016 },
      { heightM: 1_500, temperatureK: 288.5, pressurePa: 84_000, waterVaporSpecificHumidityKgPerKg: 0.012 },
      { heightM: 3_000, temperatureK: 278.5, pressurePa: 70_000, waterVaporSpecificHumidityKgPerKg: 0.007 },
      { heightM: 6_000, temperatureK: 256, pressurePa: 47_000, waterVaporSpecificHumidityKgPerKg: 0.0015 },
      { heightM: 9_000, temperatureK: 236, pressurePa: 31_000, waterVaporSpecificHumidityKgPerKg: 0.0002 },
      { heightM: 12_000, temperatureK: 216, pressurePa: 20_000, waterVaporSpecificHumidityKgPerKg: 0.00004 },
      { heightM: 14_500, temperatureK: 220, pressurePa: 15_000, waterVaporSpecificHumidityKgPerKg: 0.00002 },
    ].map((level) => ({
      ...level,
      liquidWaterMixingRatioKgPerKg: 0,
      iceMixingRatioKgPerKg: 0,
      eastWindMps: 0.2,
      northWindMps: 0,
      largeScaleVerticalVelocityMps: 0,
    })),
    surfaceSensibleHeatFluxWPerM2: 0,
    surfaceLatentHeatFluxWPerM2: 0,
    cloudTopLongwaveCoolingKPerS: 0,
    gravityWaveSource: null,
    upperIceLayerBottomM: 6_000,
    upperIceLayerTopM: 11_000,
  });
  const eventAreas = deriveCloudEventAreas(
    event, material, environment, windAt,
    CELL_WIDTH_M * CELL_HEIGHT_M,
    WIDTH * CELL_WIDTH_M * (HEIGHT * CELL_HEIGHT_M),
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
    eventAreas.sourceAreaM2,
    eventAreas.footprints,
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
    const source = sampleEventOpticalVolume();
    const volume = new CloudOpticalVolume(source, { storageFormat });
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
    return {
      objects,
      camera,
      readGpuTextureDiagnostic: (readLayer) => gpuTextureReadbackReport(volume, source, readLayer),
      dispose: () => volume.dispose(),
    };
  };
}

export const CLOUD_EVENT_OPTICAL_VOLUME_CASE: CaseBuilder = cloudEventOpticalVolumeCase();
export const CLOUD_EVENT_OPTICAL_VOLUME_RG16F_CASE: CaseBuilder = cloudEventOpticalVolumeCase('rg16f');
