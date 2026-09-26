// 雲イベントの source / footprint 面積を、環境診断と輸送時刻から導出する物理閉包。
// 堆積が要求する明示面積を、固定値ではなく対流の強さ・安定度・風の鉛直差・滞留時間・
// 昇華寿命から決める。
// source 面積は上昇コアの断面積。CAPE を全て運動エネルギーへ換えた理想化上昇速度
// w_max = √(2·CAPE) [J/kg = m²/s² → m/s] と、対流上部の混合時定数 τ_mix [s] から
// r_core = w_max·τ_mix を立てる。τ_mix は平衡高度を含む層の浮力振動数 N から
// τ_mix = 1/N とする(上昇流が安定層に突入してエントレインメントと混合する時間は、
// 浮力振動の1周期の程度 — 実際の上昇速度はエントレインメントと凝結物荷重で
// w_max より小さいので、コア半径は上限側の見積もり)。
// footprint 面積はコア半径を初期値とした円で、半径の二乗に次の3項を加える:
//   乱流拡散 σ_d² = r_core²·t/τ_d   (バルク横拡散係数 K = r_core²/(2τ_d) と等価)
//   鉛直シアの横ずれ (|u(z)−u(z_src)|·t_res)²  — 材料の高さと源の高さの風差が
//     滞留時間だけずれを引き伸ばす
//   氷のみ かなとこ流出 r_a = γ·w_max·min(t, τ_sub) — 脱層流出は上昇速度の程度で
//     進み、昇華寿命 τ_sub を超えては広がらない
// 拡散とかなとこ項は、連続放出を時刻ごとの独立した雲塊ではなく1枚の広がる雲板として
// 扱い、イベント共通の滞留時間を使う。そのため cohort 間の面積差はシア項だけから
// 生じ、無風の環境ではゼロになる。CAPE=0 では w_max=0 で拡散・流出・コア半径の全項が
// 消え、全面積が下限へ縮退する。シア項は輸送時刻の瞬間シアを滞留時間へ掛ける代理で、
// 履歴積分ではない。
// 係数は観測校正済みではない次数のバルク推定。粒径・微物理は含まない。

import { len, v3 } from '../../math/vec3';
import type { Vec3 } from '../../math/vec3';
import type { CloudEnvironmentProfile } from './cloud-environment';
import type { ConvectiveCloudEvent } from './cloud-events';
import type { CloudEventFootprintAreas } from './cloud-event-local-deposition';
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
  // 材料ごとの現在の投影面積。堆積の明示面積入力と同じ形。
  readonly footprints: CloudEventFootprintAreas;
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

// 同じ方位の2高度の水平風差 [m/s]。材料の層をまたぐ風差が footprint を伸ばす。
function windShearMagnitudeMPerS(
  windAt: CloudEventWindAt,
  directionUnitVector: Vec3,
  lowerHeightM: number,
  upperHeightM: number,
  timeSeconds: number,
): number {
  const lower = windAt(directionUnitVector, lowerHeightM, timeSeconds).tangentVelocityMPerS;
  const upper = windAt(directionUnitVector, upperHeightM, timeSeconds).tangentVelocityMPerS;
  for (const [name, vector] of Object.entries({ lower, upper })) {
    requireFinite(vector.x, `windAt ${name}.x`);
    requireFinite(vector.y, `windAt ${name}.y`);
    requireFinite(vector.z, `windAt ${name}.z`);
  }
  return len(v3(upper.x - lower.x, upper.y - lower.y, upper.z - lower.z));
}

// イベント・材料・環境・風から、堆積へ渡す source 面積と材料ごとの footprint 面積を返す。
// 下限は受け手の格子1セル、上限はイベント域の面積を想定し、どちらも呼び出し側が与える。
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

  const clampAreaM2 = (areaM2: number): number => (
    Math.min(Math.max(areaM2, minimumAreaM2), maximumAreaM2)
  );
  const minimumFootprints: CloudEventFootprintAreas = {
    parentLiquidM2: material.parent === null ? null : minimumAreaM2,
    releasedIceCohorts: material.releasedIceCohorts.map((cohort) => ({
      cohortIndex: cohort.cohortIndex,
      areaM2: minimumAreaM2,
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

  // 材料の高さと源の高さの風差 × 滞留時間。滞留が無い、材料が無い(源が無い)ときは 0。
  const shearDriftM = (heightM: number, residenceSeconds: number): number => {
    if (residenceSeconds <= 0 || sourcePosition === undefined) return 0;
    return windShearMagnitudeMPerS(
      windAt, sourcePosition.directionUnitVector,
      sourcePosition.geometricHeightM, heightM, sampleTimeSeconds,
    ) * residenceSeconds;
  };

  let parentLiquidM2: number | null = null;
  if (material.parent !== null) {
    requireFinite(material.parent.geometricHeightM, 'parent.geometricHeightM');
    const residenceSeconds = event.ageSeconds;
    const driftM = shearDriftM(material.parent.geometricHeightM, residenceSeconds);
    const radiusSquaredM2 = coreRadiusSquaredM2
      + coreRadiusSquaredM2 * residenceSeconds / DIFFUSION_TIME_SECONDS
      + driftM * driftM;
    parentLiquidM2 = clampAreaM2(Math.PI * radiusSquaredM2);
  }

  let iceDiffusionSquaredM2 = 0;
  let anvilRadiusM = 0;
  if (hasIce && meanReleaseTimeSeconds !== null) {
    const iceResidenceSeconds = Math.max(0, sampleTimeSeconds - meanReleaseTimeSeconds);
    const sublimationRatePerSecond = event.iceRelease.sublimationRatePerSecond;
    const sublimationLifetimeSeconds = sublimationRatePerSecond > 0
      ? 1 / sublimationRatePerSecond
      : Number.POSITIVE_INFINITY;
    iceDiffusionSquaredM2 = coreRadiusSquaredM2 * iceResidenceSeconds / DIFFUSION_TIME_SECONDS;
    anvilRadiusM = ANVIL_OUTFLOW_FRACTION * updraftSpeedMaxMPerS
      * Math.min(iceResidenceSeconds, sublimationLifetimeSeconds);
  }
  const releasedIceCohorts = material.releasedIceCohorts.map((cohort) => {
    const residenceSeconds = Math.max(0, sampleTimeSeconds - cohort.meanReleaseTimeSeconds);
    const driftM = shearDriftM(cohort.geometricHeightM, residenceSeconds);
    const radiusSquaredM2 = coreRadiusSquaredM2
      + iceDiffusionSquaredM2
      + anvilRadiusM * anvilRadiusM
      + driftM * driftM;
    return { cohortIndex: cohort.cohortIndex, areaM2: clampAreaM2(Math.PI * radiusSquaredM2) };
  });

  return {
    sourceAreaM2: clampAreaM2(Math.PI * coreRadiusSquaredM2),
    footprints: { parentLiquidM2, releasedIceCohorts },
  };
}
