// 雲粒の輸送。風を吹いていく向きとして読み、局所接平面上の速度を時間中点で評価する RK2 で
// 雲粒の軌道を再構成する。球面上の各移動には解析大円 step を用い、中点の接線風は大円に沿う
// 平行移動で開始点へ戻してから 1 step 進める。決定性は windAt が純関数であることを前提とする。
import { advectSphericalPositionUnitVector } from '../../physics/cloud-spherical-transport';
import { cross, len, norm, rotateAxis, scale, v3 } from '../../math/vec3';
import type { Vec3 } from '../../math/vec3';

export interface CloudParcelWind {
  readonly tangentVelocityMPerS: Vec3;
  readonly verticalVelocityMPerS: number;
}

export type CloudParcelWindAt = (
  directionUnitVector: Vec3,
  geometricHeightM: number,
  timeS: number,
) => CloudParcelWind;

export interface CloudParcelPosition {
  readonly directionUnitVector: Vec3;
  readonly geometricHeightM: number;
  readonly steps: number;
}

const CLOUD_PARCEL_MAX_STEPS = 1_000_000;

function requireFiniteTransportValue(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function requirePositiveTransportValue(value: number, name: string): void {
  requireFiniteTransportValue(value, name);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
}

function sampleParcelWind(
  windAt: CloudParcelWindAt,
  directionUnitVector: Vec3,
  geometricHeightM: number,
  timeS: number,
): CloudParcelWind {
  const wind = windAt(directionUnitVector, geometricHeightM, timeS);
  requireFiniteTransportValue(wind.tangentVelocityMPerS.x, 'tangentVelocityMPerS.x');
  requireFiniteTransportValue(wind.tangentVelocityMPerS.y, 'tangentVelocityMPerS.y');
  requireFiniteTransportValue(wind.tangentVelocityMPerS.z, 'tangentVelocityMPerS.z');
  requireFiniteTransportValue(wind.verticalVelocityMPerS, 'verticalVelocityMPerS');
  return wind;
}

// 風を吹いていく向きとして読み、局所接平面上の速度を時間中点で評価する RK2 で雲を再構成する。
// 球面上の各移動には解析大円stepを用い、中点の接線風は大円に沿う平行移動で開始点へ戻してから
// 1 step 進める。高度は幾何高度[m]、時刻とstepは[s]。決定性はwindAtが純関数であることを前提とする。
// 適用限界: 風が1 step内で急変する場合はmaxStepSを小さくする。有限step上限を超える入力は拒否する。
export function reconstructCloudParcel(
  startDirectionUnitVector: Vec3,
  startGeometricHeightM: number,
  sphereRadiusM: number,
  startTimeS: number,
  endTimeS: number,
  maxStepS: number,
  windAt: CloudParcelWindAt,
): CloudParcelPosition {
  requireFiniteTransportValue(startDirectionUnitVector.x, 'startDirectionUnitVector.x');
  requireFiniteTransportValue(startDirectionUnitVector.y, 'startDirectionUnitVector.y');
  requireFiniteTransportValue(startDirectionUnitVector.z, 'startDirectionUnitVector.z');
  requireFiniteTransportValue(startGeometricHeightM, 'startGeometricHeightM');
  requirePositiveTransportValue(sphereRadiusM, 'sphereRadiusM');
  requireFiniteTransportValue(startTimeS, 'startTimeS');
  requireFiniteTransportValue(endTimeS, 'endTimeS');
  requirePositiveTransportValue(maxStepS, 'maxStepS');
  if (typeof windAt !== 'function') throw new TypeError('windAt must be a function');
  const elapsedTimeS = endTimeS - startTimeS;
  requireFiniteTransportValue(elapsedTimeS, 'endTimeS - startTimeS');
  const stepCount = Math.ceil(Math.abs(elapsedTimeS) / maxStepS);
  if (stepCount > CLOUD_PARCEL_MAX_STEPS) {
    throw new RangeError(`transport requires more than ${CLOUD_PARCEL_MAX_STEPS} steps`);
  }
  const initialRadiusM = sphereRadiusM + startGeometricHeightM;
  if (!Number.isFinite(initialRadiusM) || initialRadiusM <= 0) {
    throw new RangeError('sphereRadiusM + startGeometricHeightM must be positive and finite');
  }
  const initialDirection = advectSphericalPositionUnitVector(
    startDirectionUnitVector, v3(0, 0, 0), sphereRadiusM, 0,
  );
  if (stepCount === 0) {
    return { directionUnitVector: initialDirection, geometricHeightM: startGeometricHeightM, steps: 0 };
  }

  const stepTimeS = elapsedTimeS / stepCount;
  let directionUnitVector = initialDirection;
  let geometricHeightM = startGeometricHeightM;
  for (let stepIndex = 0; stepIndex < stepCount; stepIndex += 1) {
    const timeS = startTimeS + stepTimeS * stepIndex;
    const midpointTimeS = timeS + stepTimeS / 2;
    const startRadiusM = sphereRadiusM + geometricHeightM;
    if (startRadiusM <= 0) throw new RangeError('sphereRadiusM + geometricHeightM must be positive');
    const startWind = sampleParcelWind(windAt, directionUnitVector, geometricHeightM, timeS);
    const startSpeedMPerS = len(startWind.tangentVelocityMPerS);
    const midpointHeightM = geometricHeightM + startWind.verticalVelocityMPerS * stepTimeS / 2;
    const midpointRadiusM = sphereRadiusM + midpointHeightM;
    if (!Number.isFinite(midpointHeightM) || !Number.isFinite(midpointRadiusM) || midpointRadiusM <= 0) {
      throw new RangeError('midpoint sphere radius must be positive and finite');
    }
    const halfAngleRad = startSpeedMPerS * stepTimeS / (2 * startRadiusM);
    requireFiniteTransportValue(halfAngleRad, 'midpoint angular displacement');
    const initialTangentDirection = startSpeedMPerS === 0
      ? v3(0, 0, 0)
      : scale(startWind.tangentVelocityMPerS, 1 / startSpeedMPerS);
    const rotationAxis = startSpeedMPerS === 0
      ? v3(0, 0, 0)
      : norm(cross(directionUnitVector, initialTangentDirection));
    const midpointDirectionUnitVector = advectSphericalPositionUnitVector(
      directionUnitVector,
      startWind.tangentVelocityMPerS,
      startRadiusM,
      stepTimeS / 2,
    );
    const midpointWind = sampleParcelWind(
      windAt, midpointDirectionUnitVector, midpointHeightM, midpointTimeS,
    );
    const midpointWindAtStart = startSpeedMPerS === 0
      ? midpointWind.tangentVelocityMPerS
      : rotateAxis(midpointWind.tangentVelocityMPerS, rotationAxis, -halfAngleRad);
    directionUnitVector = advectSphericalPositionUnitVector(
      directionUnitVector,
      midpointWindAtStart,
      midpointRadiusM,
      stepTimeS,
    );
    geometricHeightM += midpointWind.verticalVelocityMPerS * stepTimeS;
    requireFiniteTransportValue(geometricHeightM, 'geometricHeightM');
    const updatedRadiusM = sphereRadiusM + geometricHeightM;
    if (!Number.isFinite(updatedRadiusM) || updatedRadiusM <= 0) {
      throw new RangeError('updated sphere radius must be positive and finite');
    }
  }
  return { directionUnitVector, geometricHeightM, steps: stepCount };
}
