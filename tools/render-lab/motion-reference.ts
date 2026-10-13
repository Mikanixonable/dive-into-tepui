// 実体ごとの CPU レイから、同じ表面点が前後フレームで写る画素と深度の整合を求める。
import * as THREE from 'three/webgpu';
import { reprojectPixelAtDepth } from './reference-reprojection';
import type { FloatImage } from './lab';
import type { LabMotionEntity } from './lab-case';

// レイを当てる仮の Mesh の材質。Raycaster は材質の面の向きで当たりを選ぶので、G バッファと同じく表面だけに当てる。
const RAY_MATERIAL = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });

// 前フレームが無い標本を PNG で示す色(紫。8 bit の RGB)。
const NO_HISTORY_RGB = [160, 32, 240] as const;
// レイを飛ばす画素の間隔 [px]。
const SAMPLE_STEP = 4;
// CPU 経路どうしの動き差の許容値 [px]。
const SELF_CHECK_TOLERANCE_PX = 1e-6;
// 従来の深度整合で同じ面とみなす相対差。
const DEPTH_RELATIVE_TOLERANCE = 1e-4;
// 中心線の深度二階差がこの割合を超えた標本を滑らかでない輪郭とする。
const DEPTH_CURVATURE_TOLERANCE = 1e-3;
// GPU のラスタライズ小数精度は画素位置の小数部 8 bit。
const RASTER_SUBPIXEL_BITS = 8;
// 深度誤差の上限へ使う、画素位置の丸め誤差 [px]。
const RASTER_POSITION_ERROR_PX = 2 ** -(RASTER_SUBPIXEL_BITS + 1);

// 参照を求める 1 フレーム。camera は描画の座標(浮動原点で置き直した後)のカメラ、origin はその描画の座標の原点の
// ケースの世界の座標、entities はケースの世界の座標で置いた実体、depth は G バッファの素の深度。
export interface MotionReferenceFrame {
  readonly depth: FloatImage;
  readonly motion: FloatImage;
  readonly camera: THREE.PerspectiveCamera;
  readonly origin: THREE.Vector3;
  readonly entities: readonly LabMotionEntity[];
  readonly rejectedObjects: readonly THREE.Object3D[];
}

// 1 フレームの参照の要約。標本は SAMPLE_STEP おきの画素で、面のある標本だけを数える。輪郭は 3×3 の近傍のレイで決める。
export interface MotionReferenceMetrics {
  // 間引いた画素の数。
  readonly sampleCount: number;
  // レイが面へ当たった標本の数。
  readonly surfaceCount: number;
  // 近傍に面が無いか別の実体へ当たった輪郭の、面のある標本に対する割合。
  readonly entityOutlineFraction: number;
  // 近傍の深さの 2 階差で滑らかでないとした輪郭の割合(上と重ならない)。
  readonly depthOutlineFraction: number;
  // 上の 2 種を合わせた輪郭の割合。
  readonly outlineFraction: number;
  // 輪郭を除いた標本の、レイの深さと G バッファの深度の相対差 ρ の最大。
  readonly depthRatioMax: number;
  // ρ をラスタライズの丸めの上限 ρ_max で割った値の 99.9% 分位と最大、1 を超えた標本の数。
  readonly rasterToleranceRatioP999: number;
  readonly rasterToleranceRatioMax: number;
  readonly rasterToleranceAboveLimitCount: number;
  // ρ が DEPTH_RELATIVE_TOLERANCE を超えた標本の数と、その標本での ρ / ρ_max の最大。
  readonly depthRatioAboveLimitCount: number;
  readonly depthRatioAboveLimitNormalizedMax: number;
  // ρ が最大の標本の画素の座標。
  readonly depthRatioMaxPixel: readonly [number, number] | null;
  // 前フレームに同じ鍵の実体が無い標本の数。
  readonly noHistoryCount: number;
  readonly gpuMotionCount: number;
  readonly gpuMotionRms: number;
  readonly gpuMotionP999: number;
  readonly gpuMotionMax: number;
  readonly gpuMotionAboveLimitCount: number;
  readonly rejectedPixelCount: number;
  readonly rejectedPixelMismatchCount: number;
  readonly expectedRejectedGpuValueCount: number;
  readonly expectedValueGpuRejectedCount: number;
  readonly nonFiniteGpuMovementCount: number;
  readonly rejectedObjectCount: number;
  readonly rejectedRayHitCount: number;
  readonly rejectedDepthMatchedCount: number;
  readonly comparisonExpectedCount: number;
  readonly comparisonCount: number;
  readonly sameFrameMismatchCount: number;
  readonly fullNoHistorySurfacePixelCount: number;
  readonly fullNoHistoryMismatchCount: number;
  // CPU の経路どうしの自己検算(当たりの点の深度を深度の参照の写像へ通した動きと、レイの参照の動きの差)の標本の数と、
  // 差の RMS・99.9% 分位・最大 [px]、SELF_CHECK_TOLERANCE_PX を超えた標本の数、最大の画素の座標。
  readonly selfCheckCount: number;
  readonly selfCheckRms: number;
  readonly selfCheckP999: number;
  readonly selfCheckMax: number;
  readonly selfCheckAboveLimitCount: number;
  readonly selfCheckMaxPixel: readonly [number, number] | null;
  // GPU の深度による参照の再投影とレイの参照の動きの差の RMS [px]・比べた標本の数・99.9% 分位 [px]・最大 [px]と、
  // 差 / (動きの大きさ × ρ) の最大(深度の誤差が動きの差の元なら 1 の桁)。
  readonly gpuDifferenceRms: number;
  readonly gpuDifferenceCount: number;
  readonly gpuDifferenceP999: number;
  readonly gpuDifferenceMax: number;
  readonly gpuDifferenceNormalizedMax: number;
  // 積み順の番号で前フレームの行列を引いた場合と、レイの参照の動きの差の RMS [px]・最大 [px]・比べた標本の数。
  readonly slotErrorRms: number;
  readonly slotErrorMax: number;
  readonly slotErrorCount: number;
}

export interface MotionReferenceResult {
  readonly motionPng: string;
  readonly differencePng: string;
  readonly comparisonSamples: readonly number[];
  readonly metrics: MotionReferenceMetrics;
}

interface Sample {
  readonly x: number;
  readonly y: number;
  readonly entity: LabMotionEntity;
  readonly mesh: THREE.Mesh;
  readonly point: THREE.Vector3;
  readonly localPoint: THREE.Vector3;
  readonly movement: readonly [number, number] | null;
  readonly slotError: number | null;
  depthRatio: number;
  rasterToleranceRatio: number;
  gpuDifference: number | null;
  gpuDifferenceNormalized: number | null;
  selfError: number | null;
  outlineKind: 'none' | 'entity' | 'depth';
  gpuMovement: readonly [number, number] | null;
  motionError: number | null;
  motionToleranceRatio: number | null;
  rejected: boolean;
}

// 現在の面 hit と前フレームの写像を比べ、CPU 検算・深度整合・PNG を返す。
export async function motionReferenceOf(
  frame: MotionReferenceFrame,
  previous: MotionReferenceFrame | null,
  toPrevious: THREE.Matrix4 | null,
  gpuReprojected: Float64Array | null,
  depthSampleStep = SAMPLE_STEP,
): Promise<MotionReferenceResult> {
  const { width, height } = frame.depth;
  if (frame.entities.length === 0) {
    return depthMotionReferenceOf(frame, previous, toPrevious, depthSampleStep);
  }
  const camera = unjitteredCamera(frame.camera);
  const previousCamera = previous === null ? null : unjitteredCamera(previous.camera);
  const drawFromWorld = new THREE.Matrix4().makeTranslation(-frame.origin.x, -frame.origin.y, -frame.origin.z);
  const meshes = frame.entities.map((entity) => {
    const mesh = new THREE.Mesh(entity.geometry, RAY_MATERIAL);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.multiplyMatrices(drawFromWorld, entity.matrix);
    mesh.matrixWorld.copy(mesh.matrix);
    return { entity, mesh };
  });
  const rejectedMeshes = frame.entities.some((entity) => entity.kind === 'pool')
    ? [] : rejectedMeshesOf(frame.rejectedObjects);
  const baseRaycastMeshes = meshes.map(({ mesh }) => mesh);
  const raycastMeshes = [...baseRaycastMeshes, ...rejectedMeshes];
  const baseEntitiesByMesh = new Map<THREE.Object3D, LabMotionEntity>(meshes.map(({ entity, mesh }) => [mesh, entity]));
  const entitiesByMesh = new Map<THREE.Object3D, LabMotionEntity>([
    ...baseEntitiesByMesh.entries(),
    ...rejectedMeshes.map((mesh, index) => [mesh, {
      key: `motion-rejected:${index}`,
      kind: 'pool' as const,
      geometry: mesh.geometry,
      matrix: mesh.matrixWorld.clone(),
      slot: null,
    }] as const),
  ]);
  const byKey = new Map((previous?.entities ?? []).map((entity) => [entity.key, entity]));
  const bySlot = new Map((previous?.entities ?? [])
    .filter((entity) => entity.kind === 'pool' && entity.slot !== null)
    .map((entity) => [entity.slot!, entity]));
  const raycaster = new THREE.Raycaster();
  const intersections: THREE.Intersection[] = [];
  const rayCandidates: THREE.Mesh[] = [];
  raycaster.near = camera.near;
  raycaster.far = camera.far;
  const samples: Sample[] = [];
  let surfaceCount = 0;
  let noHistoryCount = 0;
  let rejectedPixelCount = 0;
  let rejectedPixelMismatchCount = 0;
  let expectedRejectedGpuValueCount = 0;
  let expectedValueGpuRejectedCount = 0;
  let nonFiniteGpuMovementCount = 0;

  for (let y = 0; y < height; y += SAMPLE_STEP) {
    for (let x = 0; x < width; x += SAMPLE_STEP) {
      const hit = hitAt(
        x, y, width, height, camera, frame.depth, raycaster, raycastMeshes, entitiesByMesh, intersections, rayCandidates,
      );
      if (hit === null) continue;
      surfaceCount++;
      const { entity, mesh, point } = hit;
      const localPoint = point.clone().applyMatrix4(mesh.matrixWorld.clone().invert());
      const before = byKey.get(entity.key);
      const movement = before === undefined || previousCamera === null
        ? null : movementOf(localPoint, before.matrix, previous!.origin, previousCamera, x, y, width, height);
      if (movement === null) noHistoryCount++;
      const pixelIndex = 4 * (y * width + x);
      const gpuX = frame.motion.rgba[pixelIndex]!;
      const gpuY = frame.motion.rgba[pixelIndex + 1]!;
      const gpuFinite = Number.isFinite(gpuX) && Number.isFinite(gpuY);
      const gpuRejected = gpuFinite && Math.max(Math.abs(gpuX), Math.abs(gpuY)) >= 1000;
      if (!gpuFinite) nonFiniteGpuMovementCount++;
      const expectedRejected = movement === null || entity.kind === 'pool';
      if (expectedRejected) {
        rejectedPixelCount++;
        if (!gpuRejected) {
          rejectedPixelMismatchCount++;
          expectedRejectedGpuValueCount++;
        }
      } else if (gpuRejected) {
        rejectedPixelMismatchCount++;
        expectedValueGpuRejectedCount++;
      }
      const gpuMovement: readonly [number, number] | null = gpuRejected
        ? null : [gpuX * width, gpuY * height];
      const motionError = expectedRejected || movement === null || gpuRejected ? null
        : !gpuFinite ? Number.POSITIVE_INFINITY
        : Math.hypot(gpuX * width - movement[0], gpuY * height - movement[1]);
      const motionToleranceRatio = motionError === null || movement === null ? null
        : motionError / (2 ** -10 * Math.hypot(...movement) + 0.01);

      let slotError: number | null = null;
      if (entity.kind === 'pool' && entity.slot !== null) {
        const wrong = bySlot.get(entity.slot);
        if (wrong !== undefined && previousCamera !== null) {
          const wrongMovement = movementOf(
            localPoint, wrong.matrix, previous!.origin, previousCamera, x, y, width, height,
          );
          if (movement !== null && wrongMovement !== null) {
            slotError = Math.hypot(wrongMovement[0] - movement[0], wrongMovement[1] - movement[1]);
          }
        }
      }
      samples.push({
        x, y, entity, mesh, point, localPoint, movement, slotError,
        depthRatio: 0, rasterToleranceRatio: 0, gpuDifference: null, gpuDifferenceNormalized: null,
        selfError: null, outlineKind: 'none', gpuMovement, motionError, motionToleranceRatio, rejected: expectedRejected,
      });
    }
    if ((y / SAMPLE_STEP) % 16 === 15) await yieldToBrowser();
  }

  for (const [sampleIndex, sample] of samples.entries()) {
    let relativeGradient = 1;
    if (sample.entity.kind === 'pool') {
      sample.outlineKind = 'none';
    } else {
      const neighborhood = neighborhoodOf(
        sample, width, height, camera, frame.depth, raycaster, baseRaycastMeshes, baseEntitiesByMesh,
        intersections, rayCandidates,
      );
      sample.outlineKind = neighborhood.entityEdge ? 'entity' : neighborhood.depthEdge ? 'depth' : 'none';
      relativeGradient = neighborhood.relativeGradient;
    }
    sample.depthRatio = depthRatioOf(
      sample.point, camera, frame.depth.rgba[4 * (sample.y * width + sample.x)]!,
      sample.x, sample.y, width, height,
    );
    sample.rasterToleranceRatio = sample.depthRatio / (RASTER_POSITION_ERROR_PX * relativeGradient + 1e-6);

    if (toPrevious === null || sample.movement === null) continue;
    const currentView = sample.point.clone().applyMatrix4(camera.matrixWorldInverse);
    const currentClip = new THREE.Vector4(currentView.x, currentView.y, currentView.z, 1)
      .applyMatrix4(camera.projectionMatrix);
    const projected = reprojectPixelAtDepth(
      sample.x, sample.y, currentClip.z / currentClip.w, width, height, toPrevious,
    );
    if (projected !== null) {
      const mappedMovement: readonly [number, number] = [sample.x - projected[0], sample.y - projected[1]];
      sample.selfError = Math.hypot(
        mappedMovement[0] - sample.movement[0], mappedMovement[1] - sample.movement[1],
      );
    }

    if (gpuReprojected === null) continue;
    const pixelIndex = sample.y * width + sample.x;
    const previousX = gpuReprojected[2 * pixelIndex]!;
    const previousY = gpuReprojected[2 * pixelIndex + 1]!;
    if (!Number.isFinite(previousX) || !Number.isFinite(previousY)) continue;
    sample.gpuDifference = Math.hypot(
      (sample.x - previousX) - sample.movement[0],
      (sample.y - previousY) - sample.movement[1],
    );
    const movementSize = Math.hypot(...sample.movement);
    if (movementSize > 0 && sample.depthRatio > 0) {
      sample.gpuDifferenceNormalized = sample.gpuDifference / (movementSize * sample.depthRatio);
    }
    if (sampleIndex % 256 === 255) await yieldToBrowser();
  }

  const cleanSamples = samples.filter((sample) => sample.outlineKind === 'none');
  const comparisonSamples = cleanSamples
    .filter((sample) => sample.movement !== null && sample.entity.kind !== 'pool')
    .map((sample) => Math.floor(sample.y / SAMPLE_STEP) * Math.ceil(width / SAMPLE_STEP)
      + Math.floor(sample.x / SAMPLE_STEP));
  const selfErrors = cleanSamples.flatMap((sample) => sample.selfError === null ? [] : [sample.selfError]);
  const gpuErrors = cleanSamples.flatMap((sample) => sample.gpuDifference === null ? [] : [sample.gpuDifference]);
  const normalizedGpuErrors = cleanSamples.flatMap((sample) =>
    sample.gpuDifferenceNormalized === null ? [] : [sample.gpuDifferenceNormalized]);
  const motionErrors = cleanSamples.flatMap((sample) => sample.motionError === null ? [] : [sample.motionError]);
  const comparisonExpectedCount = cleanSamples.filter((sample) =>
    sample.movement !== null && sample.entity.kind !== 'pool').length;
  const planLimitSamples = cleanSamples.filter((sample) => sample.depthRatio > DEPTH_RELATIVE_TOLERANCE);
  const depthMaxSample = maximumOf(cleanSamples, (sample) => sample.depthRatio);
  const metrics: MotionReferenceMetrics = {
    sampleCount: Math.ceil(width / SAMPLE_STEP) * Math.ceil(height / SAMPLE_STEP),
    surfaceCount,
    entityOutlineFraction: fractionOf(samples, (sample) => sample.outlineKind === 'entity'),
    depthOutlineFraction: fractionOf(samples, (sample) => sample.outlineKind === 'depth'),
    outlineFraction: fractionOf(samples, (sample) => sample.outlineKind !== 'none'),
    depthRatioMax: maxOf(cleanSamples, (sample) => sample.depthRatio),
    rasterToleranceRatioP999: percentile(cleanSamples.map((sample) => sample.rasterToleranceRatio), 0.999),
    rasterToleranceRatioMax: maxOf(cleanSamples, (sample) => sample.rasterToleranceRatio),
    rasterToleranceAboveLimitCount: cleanSamples.filter((sample) => sample.rasterToleranceRatio > 1).length,
    depthRatioAboveLimitCount: planLimitSamples.length,
    depthRatioAboveLimitNormalizedMax: maxOf(planLimitSamples, (sample) => sample.rasterToleranceRatio),
    depthRatioMaxPixel: depthMaxSample === null ? null : [depthMaxSample.x, depthMaxSample.y],
    noHistoryCount,
    gpuMotionCount: motionErrors.length,
    gpuMotionRms: rms(motionErrors),
    gpuMotionP999: percentile(motionErrors, 0.999),
    gpuMotionMax: maxOf(cleanSamples, (sample) => sample.motionError ?? 0),
    gpuMotionAboveLimitCount: cleanSamples.filter((sample) => (sample.motionToleranceRatio ?? 0) > 1).length,
    rejectedPixelCount,
    rejectedPixelMismatchCount,
    expectedRejectedGpuValueCount,
    expectedValueGpuRejectedCount,
    nonFiniteGpuMovementCount,
    rejectedObjectCount: frame.rejectedObjects.length,
    rejectedRayHitCount: 0,
    rejectedDepthMatchedCount: 0,
    comparisonExpectedCount,
    comparisonCount: motionErrors.length,
    sameFrameMismatchCount: 0,
    fullNoHistorySurfacePixelCount: 0,
    fullNoHistoryMismatchCount: 0,
    selfCheckCount: selfErrors.length,
    selfCheckRms: rms(selfErrors),
    selfCheckP999: percentile(selfErrors, 0.999),
    selfCheckMax: maxOf(cleanSamples, (sample) => sample.selfError ?? 0),
    selfCheckAboveLimitCount: selfErrors.filter((value) => value > SELF_CHECK_TOLERANCE_PX).length,
    selfCheckMaxPixel: pixelOfMaximum(cleanSamples, (sample) => sample.selfError ?? 0),
    gpuDifferenceRms: rms(gpuErrors),
    gpuDifferenceCount: gpuErrors.length,
    gpuDifferenceP999: percentile(gpuErrors, 0.999),
    gpuDifferenceMax: maxOf(cleanSamples, (sample) => sample.gpuDifference ?? 0),
    gpuDifferenceNormalizedMax: Math.max(0, ...normalizedGpuErrors),
    slotErrorRms: rms(samples.flatMap((sample) => sample.slotError === null ? [] : [sample.slotError])),
    slotErrorMax: maxOf(samples, (sample) => sample.slotError ?? 0),
    slotErrorCount: samples.filter((sample) => sample.slotError !== null).length,
  };
  return {
    motionPng: imagePng(width, height, samples, false),
    differencePng: imagePng(width, height, samples, true),
    comparisonSamples,
    metrics,
  };
}

// 静止物の実体口を持たない場面では、深度の再投影を参照にする。
async function depthMotionReferenceOf(
  frame: MotionReferenceFrame, previous: MotionReferenceFrame | null, toPrevious: THREE.Matrix4 | null,
  sampleStep: number,
): Promise<MotionReferenceResult> {
  const { width, height } = frame.depth;
  const errors: number[] = [];
  const toleranceRatios: number[] = [];
  const colors: { readonly x: number; readonly y: number; readonly movement: readonly [number, number] | null; readonly ratio: number | null }[] = [];
  let surfaceCount = 0;
  let noHistoryCount = 0;
  let rejectedPixelMismatchCount = 0;
  let expectedRejectedGpuValueCount = 0;
  let expectedValueGpuRejectedCount = 0;
  let nonFiniteGpuMovementCount = 0;
  let comparisonExpectedCount = 0;
  const comparisonSamples: number[] = [];
  let depthOutlineCount = 0;
  const camera = unjitteredCamera(frame.camera);
  const rejectedTargets = rejectedMeshesOf(frame.rejectedObjects);
  const rejectedRaycaster = new THREE.Raycaster();
  rejectedRaycaster.layers.mask = 0xffff_ffff;
  const rejectedIntersections: THREE.Intersection[] = [];
  const rejectedCandidates: THREE.Mesh[] = [];
  let rejectedRayHitCount = 0;
  let rejectedDepthMatchedCount = 0;
  for (let y = 0; y < height; y += sampleStep) {
    for (let x = 0; x < width; x += sampleStep) {
      const pixel = y * width + x;
      if (frame.depth.rgba[4 * pixel]! <= 0) continue;
      surfaceCount++;
      const outline = depthOutlineAt(frame.depth, camera, x, y, sampleStep);
      if (outline) depthOutlineCount++;
      const actualX = frame.motion.rgba[4 * pixel]!;
      const actualY = frame.motion.rgba[4 * pixel + 1]!;
      const gpuFinite = Number.isFinite(actualX) && Number.isFinite(actualY);
      const rejected = gpuFinite && Math.max(Math.abs(actualX), Math.abs(actualY)) >= 1000;
      if (!gpuFinite) nonFiniteGpuMovementCount++;
      let expectedRejectedObject = false;
      if (frame.rejectedObjects.length > 0) {
        rejectedRaycaster.setFromCamera(
          new THREE.Vector2(2 * (x + 0.5) / width - 1, 1 - 2 * (y + 0.5) / height), camera,
        );
        collectRayCandidates(rejectedTargets, rejectedRaycaster, rejectedCandidates);
        rejectedIntersections.length = 0;
        rejectedRaycaster.intersectObjects(rejectedCandidates, false, rejectedIntersections);
        const rejectedHit = rejectedIntersections[0];
        if (rejectedHit !== undefined) {
          rejectedRayHitCount++;
          expectedRejectedObject = depthRatioOf(
            rejectedHit.point, camera, frame.depth.rgba[4 * pixel]!, x, y, width, height,
          ) <= DEPTH_RELATIVE_TOLERANCE;
          if (expectedRejectedObject) rejectedDepthMatchedCount++;
        }
      }
      if (expectedRejectedObject) {
        noHistoryCount++;
        if (!rejected) {
          rejectedPixelMismatchCount++;
          expectedRejectedGpuValueCount++;
        }
        colors.push({ x, y, movement: null, ratio: null });
        continue;
      }
      if (previous === null || toPrevious === null) {
        noHistoryCount++;
        if (!rejected) {
          rejectedPixelMismatchCount++;
          expectedRejectedGpuValueCount++;
        }
        colors.push({ x, y, movement: null, ratio: null });
        continue;
      }
      const projected = reprojectPixelAtDepth(
        x, y, frame.depth.rgba[4 * pixel]!, width, height, toPrevious,
      );
      if (projected === null) {
        noHistoryCount++;
        if (!rejected) {
          rejectedPixelMismatchCount++;
          expectedRejectedGpuValueCount++;
        }
        colors.push({ x, y, movement: null, ratio: null });
        continue;
      }
      if (outline) {
        colors.push({ x, y, movement: null, ratio: null });
        continue;
      }
      comparisonExpectedCount++;
      comparisonSamples.push(Math.floor(y / sampleStep) * Math.ceil(width / sampleStep)
        + Math.floor(x / sampleStep));
      if (rejected) {
        rejectedPixelMismatchCount++;
        expectedValueGpuRejectedCount++;
        colors.push({ x, y, movement: null, ratio: null });
        continue;
      }
      const expected: readonly [number, number] = [x - projected[0], y - projected[1]];
      const actual: readonly [number, number] = [actualX * width, actualY * height];
      const error = gpuFinite ? Math.hypot(actual[0] - expected[0], actual[1] - expected[1])
        : Number.POSITIVE_INFINITY;
      const ratio = error / (2 ** -10 * Math.hypot(...expected) + 0.01);
      errors.push(error);
      toleranceRatios.push(ratio);
      colors.push({ x, y, movement: rejected ? null : actual, ratio });
    }
    if (Math.floor(y / sampleStep) % 16 === 15) await yieldToBrowser();
  }
  return {
    motionPng: sampledMotionPng(width, height, colors, false),
    differencePng: sampledMotionPng(width, height, colors, true),
    comparisonSamples,
    metrics: {
      sampleCount: Math.ceil(width / sampleStep) * Math.ceil(height / sampleStep),
      surfaceCount,
      entityOutlineFraction: 0,
      depthOutlineFraction: surfaceCount === 0 ? 0 : depthOutlineCount / surfaceCount,
      outlineFraction: surfaceCount === 0 ? 0 : depthOutlineCount / surfaceCount,
      depthRatioMax: 0,
      rasterToleranceRatioP999: 0,
      rasterToleranceRatioMax: 0,
      rasterToleranceAboveLimitCount: 0,
      depthRatioAboveLimitCount: 0,
      depthRatioAboveLimitNormalizedMax: 0,
      depthRatioMaxPixel: null,
      noHistoryCount,
      gpuMotionCount: errors.length,
      gpuMotionRms: rms(errors),
      gpuMotionP999: percentile(errors, 0.999),
      gpuMotionMax: Math.max(0, ...errors),
      gpuMotionAboveLimitCount: toleranceRatios.filter((ratio) => ratio > 1).length,
      rejectedPixelCount: noHistoryCount,
      rejectedPixelMismatchCount,
      expectedRejectedGpuValueCount,
      expectedValueGpuRejectedCount,
      nonFiniteGpuMovementCount,
      rejectedObjectCount: frame.rejectedObjects.length,
      rejectedRayHitCount,
      rejectedDepthMatchedCount,
      comparisonExpectedCount,
      comparisonCount: errors.length,
      sameFrameMismatchCount: 0,
      fullNoHistorySurfacePixelCount: 0,
      fullNoHistoryMismatchCount: 0,
      selfCheckCount: 0,
      selfCheckRms: 0,
      selfCheckP999: 0,
      selfCheckMax: 0,
      selfCheckAboveLimitCount: 0,
      selfCheckMaxPixel: null,
      gpuDifferenceRms: 0,
      gpuDifferenceCount: 0,
      gpuDifferenceP999: 0,
      gpuDifferenceMax: 0,
      gpuDifferenceNormalizedMax: 0,
      slotErrorRms: 0,
      slotErrorMax: 0,
      slotErrorCount: 0,
    },
  };
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// 深度参照の標本を動きと許容誤差比で色分けする。
// 深度だけの参照では、欠けた隣接面と深度の二階差が大きい画素を輪郭として比較から外す。
// InstancedMesh は展開し、薬莢などの印付き個体を CPU の深度参照でも個別に交差判定する。
function rejectedMeshesOf(objects: readonly THREE.Object3D[]): THREE.Mesh[] {
  const targets: THREE.Mesh[] = [];
  const instanceMatrix = new THREE.Matrix4();
  const worldMatrix = new THREE.Matrix4();
  const add = (object: THREE.Object3D, matrix: THREE.Matrix4): void => {
    const mesh = object as THREE.Mesh;
    mesh.geometry.computeBoundingSphere();
    if (mesh.geometry.boundingSphere === null) return;
    const target = new THREE.Mesh(mesh.geometry, RAY_MATERIAL);
    target.matrixAutoUpdate = false;
    target.matrix.copy(matrix);
    target.matrixWorld.copy(matrix);
    target.userData.motionReferenceSphere = mesh.geometry.boundingSphere.clone().applyMatrix4(matrix);
    targets.push(target);
  };
  for (const object of objects) {
    if (!(object instanceof THREE.InstancedMesh)) {
      add(object, object.matrixWorld);
      continue;
    }
    for (let instanceId = 0; instanceId < object.count; instanceId++) {
      object.getMatrixAt(instanceId, instanceMatrix);
      if (instanceMatrix.determinant() === 0) continue;
      worldMatrix.multiplyMatrices(object.matrixWorld, instanceMatrix);
      add(object, worldMatrix);
    }
  }
  return targets;
}

function collectRayCandidates(meshes: readonly THREE.Mesh[], raycaster: THREE.Raycaster, candidates: THREE.Mesh[]): void {
  candidates.length = 0;
  for (const mesh of meshes) {
    const sphere: THREE.Sphere | null = mesh.userData.motionReferenceSphere ?? null;
    if (sphere === null || raycaster.ray.intersectsSphere(sphere)) candidates.push(mesh);
  }
}

function depthOutlineAt(depth: FloatImage, camera: THREE.PerspectiveCamera, x: number, y: number, step: number): boolean {
  const { width, height } = depth;
  const center = depthViewZ(depth, camera, x, y);
  for (const [dx, dy] of [[step, 0], [0, step]] as const) {
    const minusX = x - dx;
    const minusY = y - dy;
    const plusX = x + dx;
    const plusY = y + dy;
    if (minusX < 0 || minusY < 0 || plusX >= width || plusY >= height) return true;
    const minus = depthViewZ(depth, camera, minusX, minusY);
    const plus = depthViewZ(depth, camera, plusX, plusY);
    if (minus === null || plus === null || center === null
      || Math.abs(minus - 2 * center + plus) > DEPTH_CURVATURE_TOLERANCE * center) return true;
  }
  return false;
}

function depthViewZ(depth: FloatImage, camera: THREE.PerspectiveCamera, x: number, y: number): number | null {
  const rawDepth = depth.rgba[4 * (y * depth.width + x)]!;
  if (rawDepth <= 0) return null;
  const point = new THREE.Vector4(
    2 * (x + 0.5) / depth.width - 1,
    1 - 2 * (y + 0.5) / depth.height,
    rawDepth,
    1,
  ).applyMatrix4(camera.projectionMatrixInverse);
  return -point.z / point.w;
}

function sampledMotionPng(
  width: number, height: number,
  samples: readonly { readonly x: number; readonly y: number; readonly movement: readonly [number, number] | null; readonly ratio: number | null }[],
  difference: boolean,
): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('render-lab: canvas 2D context is unavailable');
  context.fillStyle = '#000';
  context.fillRect(0, 0, width, height);
  for (const sample of samples) {
    const color = difference
      ? (() => { const value = THREE.MathUtils.clamp(sample.ratio ?? 0, 0, 1) * 255; return [value, value, value] as const; })()
      : sample.movement === null ? NO_HISTORY_RGB : rgbOfHsl(
        (Math.atan2(sample.movement[1], sample.movement[0]) / (2 * Math.PI) + 1) % 1,
        1,
        THREE.MathUtils.clamp(Math.log2(1 + Math.hypot(...sample.movement)) / 8, 0.08, 0.85),
      );
    context.fillStyle = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
    context.fillRect(sample.x, sample.y, SAMPLE_STEP, SAMPLE_STEP);
  }
  return canvas.toDataURL('image/png');
}

// 画素中心からの最近傍交点と、その交点を持つ実体を返す。
function hitAt(
  x: number, y: number, width: number, height: number, camera: THREE.PerspectiveCamera,
  depth: FloatImage,
  raycaster: THREE.Raycaster, meshes: THREE.Mesh[], entitiesByMesh: ReadonlyMap<THREE.Object3D, LabMotionEntity>,
  intersections: THREE.Intersection[], candidates: THREE.Mesh[],
): { readonly entity: LabMotionEntity; readonly mesh: THREE.Mesh; readonly point: THREE.Vector3 } | null {
  raycaster.setFromCamera(new THREE.Vector2(2 * (x + 0.5) / width - 1, 1 - 2 * (y + 0.5) / height), camera);
  collectRayCandidates(meshes, raycaster, candidates);
  intersections.length = 0;
  raycaster.intersectObjects(candidates, false, intersections);
  const rawDepth = depth.rgba[4 * (y * width + x)]!;
  for (const intersection of intersections) {
    const entity = entitiesByMesh.get(intersection.object);
    if (entity === undefined) continue;
    if (depthRatioOf(intersection.point, camera, rawDepth, x, y, width, height) > DEPTH_RELATIVE_TOLERANCE) continue;
    return { entity, mesh: intersection.object as THREE.Mesh, point: intersection.point };
  }
  return null;
}

// 3×3 近傍で実体の縁、深度勾配、中心線の二階差を調べる。
function neighborhoodOf(
  sample: Sample, width: number, height: number, camera: THREE.PerspectiveCamera, depth: FloatImage,
  raycaster: THREE.Raycaster,
  meshes: THREE.Mesh[], entitiesByMesh: ReadonlyMap<THREE.Object3D, LabMotionEntity>,
  intersections: THREE.Intersection[], candidates: THREE.Mesh[],
): { readonly entityEdge: boolean; readonly depthEdge: boolean; readonly relativeGradient: number } {
  const centerDepth = viewDepth(sample.point, camera);
  const neighborDepths = new Map<string, number>();
  let entityEdge = false;
  let relativeGradient = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const x = sample.x + dx;
      const y = sample.y + dy;
      if (x < 0 || x >= width || y < 0 || y >= height) {
        entityEdge = true;
        continue;
      }
      const hit = hitAt(x, y, width, height, camera, depth, raycaster, meshes, entitiesByMesh, intersections, candidates);
      if (hit === null || hit.entity.key !== sample.entity.key) {
        entityEdge = true;
        continue;
      }
      const neighborDepth = viewDepth(hit.point, camera);
      neighborDepths.set(`${dx},${dy}`, neighborDepth);
      relativeGradient = Math.max(relativeGradient,
        Math.abs(neighborDepth - centerDepth) / (centerDepth * Math.hypot(dx, dy)));
    }
  }
  let depthEdge = false;
  for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]] as const) {
    const minus = neighborDepths.get(`${-dx},${-dy}`);
    const plus = neighborDepths.get(`${dx},${dy}`);
    if (minus === undefined || plus === undefined) continue;
    if (Math.abs(minus - 2 * centerDepth + plus) > DEPTH_CURVATURE_TOLERANCE * centerDepth) depthEdge = true;
  }
  return { entityEdge, depthEdge, relativeGradient };
}

// localPoint を前の実体・カメラへ写し、x 右 y 下の画素差を返す。
function movementOf(
  localPoint: THREE.Vector3, previousModel: THREE.Matrix4, previousOrigin: THREE.Vector3,
  previousCamera: THREE.PerspectiveCamera, x: number, y: number, width: number, height: number,
): readonly [number, number] | null {
  const point = localPoint.clone().applyMatrix4(previousModel).sub(previousOrigin);
  const clip = new THREE.Vector4(point.x, point.y, point.z, 1)
    .applyMatrix4(previousCamera.matrixWorldInverse)
    .applyMatrix4(previousCamera.projectionMatrix);
  if (clip.w <= 0) return null;
  const ndcX = clip.x / clip.w;
  const ndcY = clip.y / clip.w;
  return [x - ((ndcX + 1) * width / 2 - 0.5), y - ((1 - ndcY) * height / 2 - 0.5)];
}

// 点のカメラ視線方向の深さ [m] を返す。
function viewDepth(point: THREE.Vector3, camera: THREE.PerspectiveCamera): number {
  return -point.clone().applyMatrix4(camera.matrixWorldInverse).z;
}

// レイの視線深度と素の G バッファ深度の相対差 ρ を返す。
function depthRatioOf(
  point: THREE.Vector3, camera: THREE.PerspectiveCamera, rawDepth: number,
  x: number, y: number, width: number, height: number,
): number {
  if (rawDepth <= 0) return Number.POSITIVE_INFINITY;
  const viewPoint = point.clone().applyMatrix4(camera.matrixWorldInverse);
  const reconstructed = new THREE.Vector4(
    2 * (x + 0.5) / width - 1, 1 - 2 * (y + 0.5) / height, rawDepth, 1,
  ).applyMatrix4(camera.projectionMatrixInverse);
  return Math.abs(-reconstructed.z / reconstructed.w + viewPoint.z) / Math.max(-viewPoint.z, Number.MIN_VALUE);
}

// view offset を持たない射影カメラのコピーを返す。
function unjitteredCamera(source: THREE.PerspectiveCamera): THREE.PerspectiveCamera {
  const camera = source.clone();
  if (camera.view?.enabled === true) throw new Error('render-lab: motion reference requires a camera without view offset');
  camera.updateMatrixWorld(true);
  return camera;
}

// 標本の動き(difference なら自己検算の差)を塗った、描画バッファと同じ寸法の PNG のデータ URL。
function imagePng(width: number, height: number, samples: readonly Sample[], difference: boolean): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('render-lab: canvas 2D context is unavailable');
  // 面の無い標本は黒。標本の色は、その標本が代表する SAMPLE_STEP 四方の区画へ塗る。
  context.fillStyle = '#000';
  context.fillRect(0, 0, width, height);
  for (const sample of samples) {
    const [red, green, blue] = difference ? differenceColor(sample) : motionColor(sample);
    context.fillStyle = `rgb(${red}, ${green}, ${blue})`;
    context.fillRect(sample.x, sample.y, SAMPLE_STEP, SAMPLE_STEP);
  }
  return canvas.toDataURL('image/png');
}

// 動きの向きを色相、大きさを対数の明るさへ写す。
function motionColor(sample: Sample): readonly [number, number, number] {
  if (sample.rejected || sample.gpuMovement === null) return NO_HISTORY_RGB;
  const [x, y] = sample.gpuMovement;
  const magnitude = Math.hypot(x, y);
  // 色相は 0 以上 1 未満へ畳む — rgbOfHsl は 1 以上の色相を最後の区間として扱う。
  return rgbOfHsl((Math.atan2(y, x) / (2 * Math.PI) + 1) % 1, 1,
    THREE.MathUtils.clamp(Math.log2(1 + magnitude) / 8, 0.08, 0.85));
}

// CPU 自己検算差を 10 倍して濃淡にする。
function differenceColor(sample: Sample): readonly [number, number, number] {
  if (sample.motionToleranceRatio === null) return [0, 0, 0];
  const value = THREE.MathUtils.clamp(sample.motionToleranceRatio, 0, 1);
  return [Math.round(value * 255), Math.round(value * 255), Math.round(value * 255)];
}

// HSL の単位値を PNG の RGB へ変換する。
function rgbOfHsl(hue: number, saturation: number, lightness: number): readonly [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = hue * 6;
  const secondary = chroma * (1 - Math.abs(sector % 2 - 1));
  const [red, green, blue] = sector < 1 ? [chroma, secondary, 0]
    : sector < 2 ? [secondary, chroma, 0]
      : sector < 3 ? [0, chroma, secondary]
        : sector < 4 ? [0, secondary, chroma]
          : sector < 5 ? [secondary, 0, chroma] : [chroma, 0, secondary];
  const offset = lightness - chroma / 2;
  return [red, green, blue].map((value) => Math.round((value + offset) * 255)) as [number, number, number];
}

// 対象の値を小さい順に並べ、指定分位の要素を返す。
function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
}

// 値の二乗平均平方根を返す。
function rms(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
}

// 最大値が属する標本を返す。
function maximumOf<T>(values: readonly T[], read: (value: T) => number): T | null {
  return values.reduce<T | null>((maximum, value) =>
    maximum === null || read(value) > read(maximum) ? value : maximum, null);
}

// 最大値を返す。
function maxOf<T>(values: readonly T[], read: (value: T) => number): number {
  return Math.max(0, ...values.map(read));
}

// 最大値の画素座標を返す。
function pixelOfMaximum(values: readonly Sample[], read: (value: Sample) => number): readonly [number, number] | null {
  const maximum = maximumOf(values, read);
  return maximum === null ? null : [maximum.x, maximum.y];
}

// 条件に合う標本の、面のある標本数に対する割合を返す。
function fractionOf(values: readonly Sample[], predicate: (value: Sample) => boolean): number {
  return values.length === 0 ? 0 : values.filter(predicate).length / values.length;
}
