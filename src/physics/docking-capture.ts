import { dot, len, norm, scale, sub, type Vec3 } from './vec3';

export interface DockingPortState {
  readonly classId: string;
  readonly position: Vec3;
  readonly normal: Vec3;
  readonly angularVelocity: Vec3;
}

export interface DockingCaptureLimits {
  readonly maxDistance: number;
  readonly maxLateralOffset: number;
  readonly maxFacingAngleRad: number;
  readonly minApproachSpeed: number;
  readonly maxApproachSpeed: number;
  readonly maxLateralSpeed: number;
  readonly maxAngularSpeed: number;
}

export type CaptureFailure = 'class' | 'distance' | 'lateral' | 'facing' | 'approach-too-slow' | 'approach-too-fast' | 'lateral-speed' | 'angular-speed';
export interface CaptureResult { readonly captured: boolean; readonly failures: readonly CaptureFailure[]; readonly distance: number; readonly lateralOffset: number; readonly approachSpeed: number; }

export function captureCheck(a: DockingPortState, b: DockingPortState, relativeVelocity: Vec3, limits: DockingCaptureLimits): CaptureResult {
  const axis = norm(a.normal);
  const delta = sub(b.position, a.position);
  const distance = len(delta);
  const lateralOffset = len(sub(delta, scale(axis, dot(delta, axis))));
  const approachSpeed = dot(relativeVelocity, axis);
  const facing = Math.acos(Math.max(-1, Math.min(1, dot(axis, scale(norm(b.normal), -1)))));
  const failures: CaptureFailure[] = [];
  if (a.classId !== b.classId) failures.push('class');
  if (distance > limits.maxDistance) failures.push('distance');
  if (lateralOffset > limits.maxLateralOffset) failures.push('lateral');
  if (facing > limits.maxFacingAngleRad) failures.push('facing');
  if (approachSpeed < limits.minApproachSpeed) failures.push('approach-too-slow');
  if (approachSpeed > limits.maxApproachSpeed) failures.push('approach-too-fast');
  if (len(sub(relativeVelocity, scale(axis, approachSpeed))) > limits.maxLateralSpeed) failures.push('lateral-speed');
  if (len(sub(a.angularVelocity, b.angularVelocity)) > limits.maxAngularSpeed) failures.push('angular-speed');
  return { captured: failures.length === 0, failures, distance, lateralOffset, approachSpeed };
}

export interface DockingCorrection { readonly position: Vec3; readonly positionDelta: Vec3; }

/** Correction that places b's port exactly at a's port while preserving a as the reference body. */
export function captureCorrection(a: DockingPortState, b: DockingPortState): DockingCorrection {
  const delta = sub(a.position, b.position);
  return { position: a.position, positionDelta: delta };
}
