import { airflow } from '../../physics/atmosphere';
import type { DynamicsEnvironmentSample } from '../../physics/dynamics';
import {
  aeroHeating, radiativeCooling, solarHeating, sphereNoseRadius, stepTemperature,
  stepThermalDeviation,
} from '../../physics/thermal';
import { sub, type Vec3 } from '../../math/vec3';

// 船体の放射率。
export const HULL_EMISS = 0.85;
// 放射冷却の相手とする環境温度 [K]。
export const ENV_TEMP = 255;

// 熱の状態。直列化の形を兼ね、復元では DynamicMotionProperties の同名の項目として渡す。
export interface DynamicMotionThermal {
  readonly temperature: number; // 平均温度 [K]
  readonly thermalDeviation: number; // 平均からの温度差 [K]
  readonly pendingSpecificHeat: number; // 次の熱の歩で温度へ足す熱量 [J/kg]
}

export interface DynamicMotionThermalStepInput {
  readonly dt: number;
  readonly samples: readonly DynamicsEnvironmentSample[];
  readonly radiantIntensity: number;
  readonly temperature: number;
  readonly thermalDeviation: number;
  readonly pendingSpecificHeat: number;
  readonly specificHeat: number;
  readonly bulkDensity: number;
  readonly emissivity: number;
  readonly maxTemperature: number;
  readonly bcInv: number;
  readonly radiatingAreaPerMass: number;
  readonly solarAbsorbAreaPerMass: (sunDir: Vec3) => number;
}

export interface DynamicMotionThermalStepResult {
  readonly temperature: number;
  readonly thermalDeviation: number;
  readonly pendingSpecificHeat: number;
  readonly burnedUp: boolean;
}

// 弾道係数の逆数から断面積質量比を戻すときの抗力係数 Cd。
const DRAG_COEFFICIENT = 2.2;
// 空力加熱を受ける淀み点まわりの面積が、断面積に占める割合。
const STAGNATION_AREA_FRACTION = 0.6;
// Sutton–Graves の定数(地球大気) [kg^0.5/m]。
const SG_CONST = 1.7415e-4;
// 1歩ぶんの環境標本が RK4 の4段のとき、平均に掛ける重み。
const RK4_WEIGHTS: readonly number[] = [1, 2, 2, 1];

// 環境標本から、放射・空力加熱・放射冷却を一歩ぶん進める。
export function stepThermalState(
  input: DynamicMotionThermalStepInput,
): DynamicMotionThermalStepResult {
  // 標本ごとの日射と空力加熱を重み付きで平均する。
  let heating = 0;
  let weightTotal = 0;
  for (let i = 0; i < input.samples.length; i++) {
    const weight = input.samples.length === 4 ? RK4_WEIGHTS[i]! : 1;
    const sample = input.samples[i]!;
    heating += weight * solarHeating(
      input.radiantIntensity,
      sample.sunDist,
      sample.sunlit,
      input.solarAbsorbAreaPerMass(sample.sunDir),
    );
    if (sample.atmosphere !== null && sample.atmosphereState !== null && input.bcInv > 0) {
      const { density, speed } = airflow(
        sub(sample.r, sample.atmosphereState.r),
        sub(sample.v, sample.atmosphereState.v),
        sample.atmosphere,
      );
      heating += weight * aeroHeating(
        density,
        speed,
        input.bcInv,
        SG_CONST,
        sphereNoseRadius(input.bcInv, DRAG_COEFFICIENT, input.bulkDensity),
        (STAGNATION_AREA_FRACTION * input.bcInv) / DRAG_COEFFICIENT,
      );
    }
    weightTotal += weight;
  }
  if (weightTotal > 0) heating /= weightTotal;
  // 放射冷却を差し引き、外から積まれた熱を足して温度を進める。
  const cooling = radiativeCooling(
    input.temperature,
    ENV_TEMP,
    input.emissivity,
    input.radiatingAreaPerMass,
    input.specificHeat,
    input.dt,
  );
  const temperature = stepTemperature(
    input.temperature,
    heating - cooling,
    input.specificHeat,
    input.dt,
  ) + input.pendingSpecificHeat / input.specificHeat;
  const thermalDeviation = stepThermalDeviation(
    input.thermalDeviation,
    temperature,
    input.emissivity,
    input.radiatingAreaPerMass,
    input.specificHeat,
    input.dt,
  );
  return {
    temperature,
    thermalDeviation,
    pendingSpecificHeat: 0,
    burnedUp: temperature > input.maxTemperature,
  };
}
