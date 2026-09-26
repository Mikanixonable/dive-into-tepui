// 雲イベントの source / footprint を、環境診断と輸送時刻から導出する物理閉包。
// 堆積が要求する明示形状を、固定値ではなく対流の強さ・安定度・風の鉛直差・滞留時間・
// 昇華寿命から決める。
// source 面積は上昇コアの断面積。CAPE を全て運動エネルギーへ換えた理想化上昇速度
// w_max = √(2·CAPE) [J/kg = m²/s² → m/s] と、対流上部の混合時定数 τ_mix [s] から
// r_core = w_max·τ_mix を立てる。τ_mix は平衡高度を含む層の浮力振動数 N から
// τ_mix = 1/N とする(上昇流が安定層に突入してエントレインメントと混合する時間は、
// 浮力振動の1周期の程度 — 実際の上昇速度はエントレインメントと凝結物荷重で
// w_max より小さいので、コア半径は上限側の見積もり)。
// footprint は等方半径 c と伸長ベクトル群 {v_i} の組で表し、受け手が
// G = c²·I + Σ v_i v_iᵀ の固有楕円(長半径・短半径・主軸方位)として復元する。
//   等方成分 c² = r_core² + σ_d² [+ 氷のみ r_a²]
//     σ_d² = r_core²·t/τ_d  (バルク横拡散係数 K = r_core²/(2τ_d) と等価)
//     r_a = γ·w_max·min(t, τ_sub) — かなとこ流出は上昇速度の程度の速さで
//       放射状に広がり、昇華寿命 τ_sub を超えては広がらない
//   伸長成分(源位置の接平面ベクトル、長さ = ずれ距離)
//     鉛直シアの横ずれ Δu·t_res = (u(z)−u(z_src))·t_res — 材料の高さと源の
//       高さの風差が滞留時間だけ材料を風差方向へ引き伸ばす
//     氷のみ かなとこの風下引き伸ばし u(z_ice)·min(t, τ_sub) — 上層へ出た氷は
//       その高度の流れで風下へ連なり、無風では等方広がりへ収まる
// 拡散とかなとこ項は、連続放出を時刻ごとの独立した雲塊ではなく1枚の広がる雲板として
// 扱い、イベント共通の滞留時間を使う。cohort 間の形の差はシアずれと各層の風から
// 生じ、無風の環境では全ベクトルが零で等半径の円へ収まる。CAPE=0 では w_max=0 で
// 拡散・流出・コア半径の全項が消え、全面積が下限へ縮退する。シア項は輸送時刻の
// 瞬間シアを滞留時間へ掛ける代理で、履歴積分ではない。
// 係数は観測校正済みではない次数のバルク推定。粒径・微物理は含まない。

import { cross, lenSq, scale, v3 } from '../../math/vec3';
import type { Vec3 } from '../../math/vec3';
import type { CloudEnvironmentProfile } from './cloud-environment';
import type { ConvectiveCloudEvent } from './cloud-events';
import type { CloudEventFootprintShape, CloudEventFootprintShapes } from './cloud-event-local-deposition';
import type { CloudEventMaterialCohorts, CloudEventWindAt } from './cloud-event-transport';

// 平衡高度の安定度が取れないときの混合時定数。自由対流圏の代表的な
// 浮力振動数 N≈0.01 s⁻¹ から τ_mix = 1/N ≈ 100 s。
const FALLBACK_MIXING_TIME_SECONDS = 100;
// ほぼ中立な層で τ_mix = 1/N が発散しないよう止める上限。
const MAX_MIXING_TIME_SECONDS = 1_000;
// 拡散時定数 τ_d。t=τ_d で σ_d=r_core。K = r_core²/(2τ_d) のバルク拡散と等価で、
// r_core=1〜5 km なら K≈46〜1.2×10³ m²/s — km スケールの雲域を散らす乱流拡散の次数。
const DIFFUSION_TIME_SECONDS = 10_800;
// かなとこ流出速度の w_max に対する比。w_max≈40 m/s で約12 m/s、
// 観測されるかなとこ縁の拡大速度 10〜30 m/s の次数と整合する。
const ANVIL_OUTFLOW_FRACTION = 0.3;

export interface CloudEventAreas {
  // イベントの kg/m² ledger が参照する源の断面積。m²。
  readonly sourceAreaM2: number;
  // 材料ごとの現在の footprint 形状。堆積の明示形状入力と同じ形。
  readonly footprints: CloudEventFootprintShapes;
}

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function requirePositive(value: number, name: string): void {
  requireFinite(value, name);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
}

function requireNonNegative(value: number, name: string): void {
  requireFinite(value, name);
  if (value < 0) throw new RangeError(`${name} must be non-negative`);
}

// 上昇流が打ち止まる平衡高度を含む層の浮力振動数から混合時定数を返す。
function mixingTimeSeconds(environment: CloudEnvironmentProfile): number {
  const equilibriumHeightM = environment.parcel.equilibriumHeightM;
  if (equilibriumHeightM !== null) {
    requireNonNegative(equilibriumHeightM, 'parcel.equilibriumHeightM');
    const layer = environment.layerStability.find((candidate) => (
      equilibriumHeightM >= candidate.lowerHeightM && equilibriumHeightM < candidate.upperHeightM
    ));
    const nSquared = layer?.buoyancyFrequencySquaredPerS2;
    if (nSquared !== undefined) {
      requireFinite(nSquared, 'layerStability.buoyancyFrequencySquaredPerS2');
      if (nSquared > 0) return Math.min(1 / Math.sqrt(nSquared), MAX_MIXING_TIME_SECONDS);
    }
  }
  return FALLBACK_MIXING_TIME_SECONDS;
}

// 同じ方位の2高度の水平風ベクトル [m/s]。検証はここで済ませる。
function windAtHeight(
  windAt: CloudEventWindAt,
  directionUnitVector: Vec3,
  heightM: number,
  timeSeconds: number,
): Vec3 {
  const wind = windAt(directionUnitVector, heightM, timeSeconds).tangentVelocityMPerS;
  requireFinite(wind.x, 'windAt.x');
  requireFinite(wind.y, 'windAt.y');
  requireFinite(wind.z, 'windAt.z');
  return wind;
}

// 等方半径と伸長ベクトルが作る形状行列 G = c²I + Σvvᵀ の行列式 [m⁴]。
// 面積は π·√detG。2次元では det(c²I + Σvvᵀ) = c⁴ + c²·Σ|v|² + Σ_{i<j}|v_i×v_j|² 。
function shapeAreaM2(shape: CloudEventFootprintShape): number {
  const isotropicSquaredM2 = shape.isotropicRadiusM * shape.isotropicRadiusM;
  let stretchedSquaredM2 = 0;
  let pairCrossSquaredM4 = 0;
  const vectors = shape.elongationVectorsM;
  for (const [index, vector] of vectors.entries()) {
    stretchedSquaredM2 += lenSq(vector);
    for (const other of vectors.slice(index + 1)) {
      pairCrossSquaredM4 += lenSq(cross(vector, other));
    }
  }
  const determinantM4 = isotropicSquaredM2 * isotropicSquaredM2
    + isotropicSquaredM2 * stretchedSquaredM2
    + pairCrossSquaredM4;
  return Math.PI * Math.sqrt(determinantM4);
}

// イベント・材料・環境・風から、堆積へ渡す source 面積と材料ごとの footprint 形状を返す。
// 下限は受け手の格子1セル、上限はイベント域の面積を想定し、どちらも呼び出し側が与える。
// 面積が上下限を外れるときは形(軸比・方位)を保ったまま等倍に縮める。
export function deriveCloudEventAreas(
  event: ConvectiveCloudEvent,
  material: CloudEventMaterialCohorts,
  environment: CloudEnvironmentProfile,
  windAt: CloudEventWindAt,
  minimumAreaM2: number,
  maximumAreaM2: number,
): CloudEventAreas {
  requirePositive(minimumAreaM2, 'minimumAreaM2');
  requireFinite(maximumAreaM2, 'maximumAreaM2');
  if (maximumAreaM2 < minimumAreaM2) {
    throw new RangeError('maximumAreaM2 must not be smaller than minimumAreaM2');
  }
  if (typeof windAt !== 'function') throw new TypeError('windAt must be a function');
  requireFinite(event.birthTimeSeconds, 'event.birthTimeSeconds');
  requireNonNegative(event.ageSeconds, 'event.ageSeconds');
  requireNonNegative(environment.parcel.capeJPerKg, 'environment.parcel.capeJPerKg');
  const hasMaterial = material.parent !== null || material.releasedIceCohorts.length > 0;
  if (hasMaterial && event.sourcePosition === undefined) {
    throw new RangeError('event sourcePosition is required to derive footprint areas');
  }
  const hasIce = material.releasedIceCohorts.length > 0;
  const meanReleaseTimeSeconds = event.iceRelease.meanReleaseTimeSeconds;
  if (hasIce && meanReleaseTimeSeconds === null) {
    throw new RangeError('released ice cohorts require a mean release time');
  }
  requireNonNegative(event.iceRelease.sublimationRatePerSecond, 'iceRelease.sublimationRatePerSecond');
  for (const cohort of material.releasedIceCohorts) {
    requireFinite(cohort.meanReleaseTimeSeconds, 'cohort.meanReleaseTimeSeconds');
    requireFinite(cohort.geometricHeightM, 'cohort.geometricHeightM');
  }

  const clampShape = (shape: CloudEventFootprintShape): CloudEventFootprintShape => {
    const areaM2 = shapeAreaM2(shape);
    const clampedM2 = Math.min(Math.max(areaM2, minimumAreaM2), maximumAreaM2);
    if (clampedM2 === areaM2) return shape;
    const shrink = Math.sqrt(clampedM2 / areaM2);
    return {
      isotropicRadiusM: shape.isotropicRadiusM * shrink,
      elongationVectorsM: shape.elongationVectorsM.map((vector) => scale(vector, shrink)),
    };
  };
  const minimumShape = (): CloudEventFootprintShape => ({
    isotropicRadiusM: Math.sqrt(minimumAreaM2 / Math.PI),
    elongationVectorsM: [],
  });
  const minimumFootprints: CloudEventFootprintShapes = {
    parentLiquid: material.parent === null ? null : minimumShape(),
    releasedIceCohorts: material.releasedIceCohorts.map((cohort) => ({
      cohortIndex: cohort.cohortIndex,
      shape: minimumShape(),
    })),
  };

  const capeJPerKg = environment.parcel.capeJPerKg;
  const updraftSpeedMaxMPerS = Math.sqrt(2 * capeJPerKg);
  if (updraftSpeedMaxMPerS <= 0) {
    return { sourceAreaM2: minimumAreaM2, footprints: minimumFootprints };
  }

  const coreRadiusM = updraftSpeedMaxMPerS * mixingTimeSeconds(environment);
  const coreRadiusSquaredM2 = coreRadiusM * coreRadiusM;
  const sampleTimeSeconds = event.birthTimeSeconds + event.ageSeconds;
  requireFinite(sampleTimeSeconds, 'sampleTimeSeconds');
  const sourcePosition = event.sourcePosition;

  // 材料の高さと源の高さの風差 × 滞留時間のずれベクトル [m]。滞留が無い、
  // 材料が無い(源が無い)ときは零ベクトル。
  const shearDriftVectorM = (
    materialWindMPerS: Vec3,
    residenceSeconds: number,
    sourceWindMPerS: Vec3 | null,
  ): Vec3 => {
    if (residenceSeconds <= 0 || sourceWindMPerS === null) return v3(0, 0, 0);
    return scale(v3(
      materialWindMPerS.x - sourceWindMPerS.x,
      materialWindMPerS.y - sourceWindMPerS.y,
      materialWindMPerS.z - sourceWindMPerS.z,
    ), residenceSeconds);
  };

  // 零でない伸長ベクトルだけを列挙する。零ベクトルは形へ寄与しない。
  const nonzero = (vector: Vec3): Vec3[] => (lenSq(vector) > 0 ? [vector] : []);

  const sourceWindMPerS = (hasMaterial && sourcePosition !== undefined)
    ? windAtHeight(
        windAt, sourcePosition.directionUnitVector, sourcePosition.geometricHeightM,
        sampleTimeSeconds,
      )
    : null;

  let parentLiquid: CloudEventFootprintShape | null = null;
  if (material.parent !== null) {
    requireFinite(material.parent.geometricHeightM, 'parent.geometricHeightM');
    const residenceSeconds = event.ageSeconds;
    const parentWindMPerS = windAtHeight(
      windAt, sourcePosition!.directionUnitVector, material.parent.geometricHeightM,
      sampleTimeSeconds,
    );
    const driftM = shearDriftVectorM(parentWindMPerS, residenceSeconds, sourceWindMPerS);
    const isotropicSquaredM2 = coreRadiusSquaredM2
      + coreRadiusSquaredM2 * residenceSeconds / DIFFUSION_TIME_SECONDS;
    parentLiquid = clampShape({
      isotropicRadiusM: Math.sqrt(isotropicSquaredM2),
      elongationVectorsM: nonzero(driftM),
    });
  }

  let iceDiffusionSquaredM2 = 0;
  let anvilRadiusM = 0;
  let anvilSpreadSeconds = 0;
  if (hasIce && meanReleaseTimeSeconds !== null) {
    const iceResidenceSeconds = Math.max(0, sampleTimeSeconds - meanReleaseTimeSeconds);
    const sublimationRatePerSecond = event.iceRelease.sublimationRatePerSecond;
    const sublimationLifetimeSeconds = sublimationRatePerSecond > 0
      ? 1 / sublimationRatePerSecond
      : Number.POSITIVE_INFINITY;
    iceDiffusionSquaredM2 = coreRadiusSquaredM2 * iceResidenceSeconds / DIFFUSION_TIME_SECONDS;
    anvilSpreadSeconds = Math.min(iceResidenceSeconds, sublimationLifetimeSeconds);
    anvilRadiusM = ANVIL_OUTFLOW_FRACTION * updraftSpeedMaxMPerS * anvilSpreadSeconds;
  }
  const releasedIceCohorts = material.releasedIceCohorts.map((cohort) => {
    const residenceSeconds = Math.max(0, sampleTimeSeconds - cohort.meanReleaseTimeSeconds);
    const cohortWindMPerS = windAtHeight(
      windAt, sourcePosition!.directionUnitVector, cohort.geometricHeightM, sampleTimeSeconds,
    );
    const driftM = shearDriftVectorM(cohortWindMPerS, residenceSeconds, sourceWindMPerS);
    // かなとこへ出た氷はその高度の風で風下へ引き伸ばされる。流出の等方半径とは
    // 別に、風 × 流出時間のずれを伸長ベクトルとして立てる。
    const anvilWindDriftM = scale(cohortWindMPerS, anvilSpreadSeconds);
    const isotropicSquaredM2 = coreRadiusSquaredM2
      + iceDiffusionSquaredM2
      + anvilRadiusM * anvilRadiusM;
    return {
      cohortIndex: cohort.cohortIndex,
      shape: clampShape({
        isotropicRadiusM: Math.sqrt(isotropicSquaredM2),
        elongationVectorsM: [...nonzero(driftM), ...nonzero(anvilWindDriftM)],
      }),
    };
  });

  return {
    sourceAreaM2: Math.min(Math.max(Math.PI * coreRadiusSquaredM2, minimumAreaM2), maximumAreaM2),
    footprints: { parentLiquid, releasedIceCohorts },
  };
}
