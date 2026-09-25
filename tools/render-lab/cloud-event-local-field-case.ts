// 実イベント場の RG32F ボリュームを局所光学場の frame で張り、GPU の双線形標本・地理/高度層
// 選択・光路積分を、同じ規則で計算する CPU 参照と突き合わせる診断ケース。合成場ではなく、
// 固定seedの対流イベントを質量保存の堆積へ通した場を測る。
import * as THREE from 'three/webgpu';
import { float, int, min, uv, uniformArray, vec3, vec4 } from 'three/tsl';
import { len, scale, sub, v3 } from '../../src/math/vec3';
import { integrateCloudLocalOpticalPath } from '../../src/game/cloud/cloud-local-optical-path';
import type { CloudExtinctionLayer } from '../../src/game/cloud/cloud-mass-extinction';
import {
  CloudLocalFieldSampler, cloudLocalDirectionAt, cloudLocalUvAt,
  integrateCloudLocalFieldRayCpu, sampleCloudLocalFieldCpu, validateCloudLocalFieldFrame,
  type CloudLocalFieldFrame,
} from '../../src/render/cloud/cloud-local-field';
import {
  CloudOpticalVolume, sampleCloudOpticalVolumeNode,
  type CloudOpticalVolumeData,
} from '../../src/render/cloud/cloud-optical-volume';
import { labCamera, VIEW_HEIGHT } from './lab-case';
import { sampleEventOpticalVolume } from './cloud-event-optical-volume-case';
import type { Vec3 } from '../../src/math/vec3';
import type { CaseBuilder, LabCase } from './lab-case';
import type { FloatNode, Vec3Node, Vec4Node } from '../../src/render/tsl-types';

// 堆積が使った接平面座標と局所格子。sampleEventOpticalVolume の堆積入力と同じ値でないと、
// 読む frame が焼いた場とずれる。
const FIELD_CENTER = v3(1, 0, 0);
const FIELD_EAST = v3(0, 1, 0);
const FIELD_NORTH = v3(0, 0, 1);
const SPHERE_RADIUS_M = 6_371_000;
const GRID_ORIGIN_EAST_M = -8_000;
const GRID_ORIGIN_NORTH_M = -8_000;
const CELL_WIDTH_M = 250;
const CELL_HEIGHT_M = 250;
// 格子全体が収まる十分な角距離。堆積 chart より広く取り、格子縁の外側でも場自体は有効な
// まま領域判定だけを試せるようにする。
const MAX_ANGULAR_DISTANCE_RAD = 0.02;
// 有効角距離を超える標本のための、中心からの角距離 [rad]。
const OUTSIDE_DOMAIN_ANGLE_RAD = 0.025;
const OPTICAL_VISUAL_GAIN = 120_000;
const RAY_STEPS = 32;
// ゲート。緩めず、超えたら失敗として報告する。
const MAX_POSITION_ERROR_M = 2.5;
const MAX_EXTINCTION_ERROR_PER_M = 1e-6;
const MAX_TAU_ERROR = 1e-4;

interface PointProbe {
  readonly name: string;
  readonly eastM: number;
  readonly northM: number;
  readonly altitudeM: number;
  // 有効角距離の外側を試す標本だけ、方向を直接持つ(eastM/northM は報告用の対応位置)。
  readonly directionOverride?: Vec3;
}

interface RayProbe {
  readonly name: string;
  readonly fromEastM: number;
  readonly fromNorthM: number;
  readonly fromAltitudeM: number;
  readonly toEastM: number;
  readonly toNorthM: number;
  readonly toAltitudeM: number;
}

// 中央・層境界の直上直下・細胞間の中点・格子縁の内外・体積の高度外・角距離の外側を含む。
const POINT_PROBES: readonly PointProbe[] = [
  { name: 'center-liquid', eastM: 0, northM: 0, altitudeM: 1_500 },
  { name: 'below-layer-edge', eastM: 0, northM: 0, altitudeM: 2_999.5 },
  { name: 'above-layer-edge', eastM: 0, northM: 0, altitudeM: 3_000.5 },
  { name: 'top-edge', eastM: 0, northM: 0, altitudeM: 9_000 },
  { name: 'above-volume', eastM: 0, northM: 0, altitudeM: 9_000.5 },
  { name: 'below-volume', eastM: 0, northM: 0, altitudeM: -0.5 },
  { name: 'cell-blend', eastM: 62.5, northM: 62.5, altitudeM: 1_500 },
  { name: 'offcenter-lower', eastM: 4_000, northM: -3_000, altitudeM: 1_500 },
  { name: 'upper-ice', eastM: -5_000, northM: 6_500, altitudeM: 6_000 },
  { name: 'inside-east-edge', eastM: 7_900, northM: 0, altitudeM: 1_500 },
  { name: 'outside-east-edge', eastM: 8_100, northM: 0, altitudeM: 1_500 },
  { name: 'outside-corner', eastM: -8_100, northM: -8_100, altitudeM: 1_500 },
  { name: 'inside-domain-outside-grid', eastM: 15_000, northM: 0, altitudeM: 1_500 },
  {
    name: 'outside-domain',
    eastM: SPHERE_RADIUS_M * OUTSIDE_DOMAIN_ANGLE_RAD, northM: 0, altitudeM: 1_500,
    directionOverride: v3(Math.cos(OUTSIDE_DOMAIN_ANGLE_RAD), Math.sin(OUTSIDE_DOMAIN_ANGLE_RAD), 0),
  },
];

// 鉛直・斜め・層内水平・層境界横断・格子縁を掠めるもの・完全に格子の外のもの。
const RAY_PROBES: readonly RayProbe[] = [
  { name: 'vertical-center', fromEastM: 0, fromNorthM: 0, fromAltitudeM: 0,
    toEastM: 0, toNorthM: 0, toAltitudeM: 9_000 },
  { name: 'slant-45', fromEastM: 0, fromNorthM: 0, fromAltitudeM: 0,
    toEastM: 9_000, toNorthM: 0, toAltitudeM: 9_000 },
  { name: 'horizontal-liquid', fromEastM: -7_500, fromNorthM: 0, fromAltitudeM: 1_500,
    toEastM: 7_500, toNorthM: 0, toAltitudeM: 1_500 },
  { name: 'layer-crossing', fromEastM: 0, fromNorthM: 0, fromAltitudeM: 2_500,
    toEastM: 0, toNorthM: 0, toAltitudeM: 3_500 },
  { name: 'grazing-edge', fromEastM: -7_900, fromNorthM: -2_000, fromAltitudeM: 1_500,
    toEastM: 7_900, toNorthM: 2_000, toAltitudeM: 1_500 },
  { name: 'outside-grid', fromEastM: 15_000, fromNorthM: 0, fromAltitudeM: 1_500,
    toEastM: 25_000, toNorthM: 0, toAltitudeM: 1_500 },
  { name: 'vertical-corner', fromEastM: 7_800, fromNorthM: 7_800, fromAltitudeM: 0,
    toEastM: 7_800, toNorthM: 7_800, toAltitudeM: 9_000 },
  { name: 'horizontal-ice', fromEastM: -6_000, fromNorthM: 0, fromAltitudeM: 7_000,
    toEastM: 6_000, toNorthM: 0, toAltitudeM: 7_000 },
];

// outputNode を probeCount×1 の float RT へ書き、生の float 値を読み戻す。ピクセル i が
// i 番プローブになるよう、呼び手が uv().x から列番号を引く色を組む。
async function renderProbePixels(
  renderer: THREE.WebGPURenderer, probeCount: number, outputNode: Vec4Node,
): Promise<Float32Array> {
  const target = new THREE.RenderTarget(probeCount, 1, {
    format: THREE.RGBAFormat, type: THREE.FloatType, depthBuffer: false, samples: 0,
  });
  const material = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
  material.toneMapped = false;
  // outputNode は素の vec4 が出る口 — colorNode だと a が diffuseColor.a(不透明=1)へ置き換わり、
  // rgb が max(0) で切られるので、負の uv や v の生値が読めない。
  material.outputNode = outputNode;
  const geometry = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.position.z = -0.5;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const previousTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  try {
    await renderer.renderAsync(scene, camera);
  } finally {
    renderer.setRenderTarget(previousTarget);
  }
  const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, probeCount, 1);
  target.dispose();
  material.dispose();
  geometry.dispose();
  if (pixels instanceof Float32Array) return pixels;
  // rgba32float の読み戻しは float 配列のはず。生バイトが別型で返ったときだけ、バイト数が
  // 一致するか確かめたうえで float として読み直す。
  if (pixels.byteLength !== probeCount * 4 * 4) {
    throw new Error(`probe readback returned ${pixels.byteLength} bytes; expected ${probeCount * 16}`);
  }
  return new Float32Array(pixels.buffer, pixels.byteOffset, probeCount * 4);
}

// 局所 ENU の端点を、正規化空間(|位置|=1 が地表)の直線光路へ写す。
function normalizedRay(probe: RayProbe, frame: CloudLocalFieldFrame): {
  readonly positionN: Vec3; readonly directionN: Vec3;
} {
  const fromDirection = cloudLocalDirectionAt(probe.fromEastM, probe.fromNorthM, frame);
  const toDirection = cloudLocalDirectionAt(probe.toEastM, probe.toNorthM, frame);
  const positionN = scale(fromDirection, 1 + probe.fromAltitudeM / frame.sphereRadiusM);
  const toN = scale(toDirection, 1 + probe.toAltitudeM / frame.sphereRadiusM);
  const delta = sub(toN, positionN);
  return { positionN, directionN: scale(delta, 1 / len(delta)) };
}

// GPU の点標本・光路積分を float RT から読み、同規則 CPU 参照と厳密セル横断の参照を併記する。
// ゲート判定に使うのは同規則 CPU との差で、厳密参照は方法差の報告にとどめる。
async function gpuLocalFieldDiagnostic(
  renderer: THREE.WebGPURenderer,
  source: CloudOpticalVolumeData,
  volume: CloudOpticalVolume,
  frame: CloudLocalFieldFrame,
): Promise<unknown> {
  const sampler = new CloudLocalFieldSampler();
  sampler.bind({ texture: volume.texture, frame });
  const spanEastM = frame.gridWidth * frame.cellWidthM;
  const spanNorthM = frame.gridHeight * frame.cellHeightM;

  // 点標本プローブ。列 i が i 番プローブの vec4(液, 氷, u, v) を受け取る。
  const pointDirections = POINT_PROBES.map((probe) =>
    probe.directionOverride ?? cloudLocalDirectionAt(probe.eastM, probe.northM, frame));
  const pointDirectionNodes = uniformArray(
    pointDirections.map((d) => new THREE.Vector3(d.x, d.y, d.z)), 'vec3');
  const pointAltitudeNodes = uniformArray(POINT_PROBES.map((probe) => probe.altitudeM));
  const pointIndex = int(min(uv().x.mul(POINT_PROBES.length).floor(), POINT_PROBES.length - 1));
  const pointDirection = pointDirectionNodes.element(pointIndex) as unknown as Vec3Node;
  const pointSample = sampler.sampleLocalOptical(
    pointDirection, pointAltitudeNodes.element(pointIndex) as unknown as FloatNode);
  const pointUv = sampler.localUvAt(pointDirection).uv;
  const pointPixels = await renderProbePixels(renderer, POINT_PROBES.length, vec4(
    pointSample.liquidExtinctionPerM, pointSample.iceExtinctionPerM, pointUv.x, pointUv.y));

  // 光路プローブ。列 i が i 番レイの vec4(液τ, 氷τ, 計τ, T) を受け取る。
  const rays = RAY_PROBES.map((probe) => ({ probe, ...normalizedRay(probe, frame) }));
  const rayPositionNodes = uniformArray(
    rays.map((ray) => new THREE.Vector3(ray.positionN.x, ray.positionN.y, ray.positionN.z)), 'vec3');
  const rayDirectionNodes = uniformArray(
    rays.map((ray) => new THREE.Vector3(ray.directionN.x, ray.directionN.y, ray.directionN.z)), 'vec3');
  const rayIndex = int(min(uv().x.mul(rays.length).floor(), rays.length - 1));
  const rayPath = sampler.localOpticalPathAt(
    rayPositionNodes.element(rayIndex) as unknown as Vec3Node,
    rayDirectionNodes.element(rayIndex) as unknown as Vec3Node,
    RAY_STEPS,
  );
  const rayPixels = await renderProbePixels(renderer, rays.length, rayPath);

  const pointProbes = POINT_PROBES.map((probe, index) => {
    const direction = pointDirections[index]!;
    const cpuUv = cloudLocalUvAt(direction, frame);
    const cpu = sampleCloudLocalFieldCpu(source, direction, probe.altitudeM, frame);
    const gpu = {
      liquidExtinctionPerM: pointPixels[index * 4]!,
      iceExtinctionPerM: pointPixels[index * 4 + 1]!,
      u: pointPixels[index * 4 + 2]!,
      v: pointPixels[index * 4 + 3]!,
    };
    const extinctionErrorPerM = Math.max(
      Math.abs(gpu.liquidExtinctionPerM - cpu.liquidExtinctionPerM),
      Math.abs(gpu.iceExtinctionPerM - cpu.iceExtinctionPerM),
    );
    const positionErrorM = cpuUv === null ? null : Math.max(
      Math.abs(gpu.u - cpuUv.u) * spanEastM,
      Math.abs(gpu.v - cpuUv.v) * spanNorthM,
    );
    return {
      name: probe.name,
      eastM: probe.eastM, northM: probe.northM, altitudeM: probe.altitudeM,
      direction: { x: direction.x, y: direction.y, z: direction.z },
      cpu: {
        liquidExtinctionPerM: cpu.liquidExtinctionPerM,
        iceExtinctionPerM: cpu.iceExtinctionPerM,
        u: cpuUv?.u ?? null, v: cpuUv?.v ?? null,
        insideDomain: cpuUv !== null,
      },
      gpu,
      positionErrorM,
      extinctionErrorPerM,
      pass: extinctionErrorPerM <= MAX_EXTINCTION_ERROR_PER_M
        && (positionErrorM === null || positionErrorM <= MAX_POSITION_ERROR_M),
    };
  });

  // 厳密セル横断の参照。セル内一定消散・接平面直線の方法差を示すだけで、ゲートには使わない。
  const cellCount = source.width * source.height;
  const strictLayers: CloudExtinctionLayer[] = [];
  for (let layer = 0; layer < source.layerEdgesM.length - 1; layer += 1) {
    strictLayers.push({
      lowerAltitudeM: source.layerEdgesM[layer]!,
      upperAltitudeM: source.layerEdgesM[layer + 1]!,
      liquidPerMByCell: Array.from(
        source.liquidExtinctionPerM.subarray(layer * cellCount, (layer + 1) * cellCount)),
      icePerMByCell: Array.from(
        source.iceExtinctionPerM.subarray(layer * cellCount, (layer + 1) * cellCount)),
    });
  }
  const strictGrid = {
    originEastM: frame.gridOriginEastM, originNorthM: frame.gridOriginNorthM,
    cellWidthM: frame.cellWidthM, cellHeightM: frame.cellHeightM,
    width: frame.gridWidth, height: frame.gridHeight,
  };
  const rayProbes = rays.map(({ probe, positionN, directionN }, index) => {
    const cpu = integrateCloudLocalFieldRayCpu(positionN, directionN, source, frame, RAY_STEPS);
    const strict = integrateCloudLocalOpticalPath(
      { eastM: probe.fromEastM, northM: probe.fromNorthM, altitudeM: probe.fromAltitudeM },
      { eastM: probe.toEastM, northM: probe.toNorthM, altitudeM: probe.toAltitudeM },
      strictGrid, strictLayers,
    );
    const gpu = {
      liquidTau: rayPixels[index * 4]!,
      iceTau: rayPixels[index * 4 + 1]!,
      totalTau: rayPixels[index * 4 + 2]!,
      transmittance: rayPixels[index * 4 + 3]!,
    };
    const strictTotalTau = strict.liquidOpticalDepth + strict.iceOpticalDepth;
    const tauError = Math.max(
      Math.abs(gpu.liquidTau - cpu.liquidTau),
      Math.abs(gpu.iceTau - cpu.iceTau),
      Math.abs(gpu.totalTau - cpu.totalTau),
    );
    return {
      name: probe.name,
      from: { eastM: probe.fromEastM, northM: probe.fromNorthM, altitudeM: probe.fromAltitudeM },
      to: { eastM: probe.toEastM, northM: probe.toNorthM, altitudeM: probe.toAltitudeM },
      gpu,
      cpu,
      strictReference: {
        liquidTau: strict.liquidOpticalDepth,
        iceTau: strict.iceOpticalDepth,
        totalTau: strictTotalTau,
        transmittance: strict.transmittance,
      },
      gpuMinusStrictTotalTau: gpu.totalTau - strictTotalTau,
      tauError,
      pass: tauError <= MAX_TAU_ERROR,
    };
  });

  const maxPositionErrorM = Math.max(...pointProbes.map((probe) => probe.positionErrorM ?? 0));
  const maxExtinctionErrorPerM = Math.max(
    ...pointProbes.map((probe) => probe.extinctionErrorPerM));
  const maxTauError = Math.max(...rayProbes.map((probe) => probe.tauError));
  const pass = maxPositionErrorM <= MAX_POSITION_ERROR_M
    && maxExtinctionErrorPerM <= MAX_EXTINCTION_ERROR_PER_M
    && maxTauError <= MAX_TAU_ERROR;
  return {
    frame: {
      centerDirection: frame.centerDirection,
      eastDirection: frame.eastDirection,
      northDirection: frame.northDirection,
      sphereRadiusM: frame.sphereRadiusM,
      gridOriginEastM: frame.gridOriginEastM,
      gridOriginNorthM: frame.gridOriginNorthM,
      cellWidthM: frame.cellWidthM,
      cellHeightM: frame.cellHeightM,
      gridWidth: frame.gridWidth,
      gridHeight: frame.gridHeight,
      spanEastM,
      spanNorthM,
      maxAngularDistanceRad: frame.maxAngularDistanceRad,
      layerEdgesM: [...frame.layerEdgesM],
    },
    volume: {
      width: volume.width,
      height: volume.height,
      depth: volume.depth,
      storageFormat: volume.storageFormat,
      estimatedGpuBaseLevelBytes: volume.estimatedGpuBaseLevelBytes,
      cpuBackingBytes: volume.cpuBackingBytes,
    },
    method: 'GPU float render-target probes versus the same-rule CPU reference; '
      + 'the strict cell-traversal reference is reported for method difference only',
    gates: {
      maxPositionErrorM: MAX_POSITION_ERROR_M,
      maxExtinctionErrorPerM: MAX_EXTINCTION_ERROR_PER_M,
      maxTauError: MAX_TAU_ERROR,
    },
    maxErrors: {
      positionErrorM: maxPositionErrorM,
      extinctionErrorPerM: maxExtinctionErrorPerM,
      tauError: maxTauError,
    },
    pointProbes,
    rayProbes,
    status: pass ? 'pass' : 'fail',
  };
}

export const CLOUD_EVENT_LOCAL_FIELD_CASE: CaseBuilder = (): LabCase => {
  const source = sampleEventOpticalVolume();
  const volume = new CloudOpticalVolume(source, { storageFormat: 'rg32f' });
  // 堆積と同じ座標へ volume を張る frame。格子寸法と層境界は volume の正本から取る。
  const frame: CloudLocalFieldFrame = {
    centerDirection: FIELD_CENTER,
    eastDirection: FIELD_EAST,
    northDirection: FIELD_NORTH,
    sphereRadiusM: SPHERE_RADIUS_M,
    gridOriginEastM: GRID_ORIGIN_EAST_M,
    gridOriginNorthM: GRID_ORIGIN_NORTH_M,
    cellWidthM: CELL_WIDTH_M,
    cellHeightM: CELL_HEIGHT_M,
    gridWidth: source.width,
    gridHeight: source.height,
    maxAngularDistanceRad: MAX_ANGULAR_DISTANCE_RAD,
    layerEdgesM: [...source.layerEdgesM],
  };
  validateCloudLocalFieldFrame(frame);
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
    readGpuTextureDiagnostic: (_readLayer, renderer) =>
      gpuLocalFieldDiagnostic(renderer, source, volume, frame),
    dispose: () => volume.dispose(),
  };
};
