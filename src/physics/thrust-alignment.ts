import { add, cross, norm, scale, sub, type Vec3, v3 } from './vec3';

export interface EngineThrustVector {
  readonly position: Vec3;
  readonly direction: Vec3;
  readonly maxThrust: number;
  readonly gimbalRangeDeg: number;
  readonly gimbalRateDegPerSecond: number;
}

export interface ResultantThrust { readonly force: Vec3; readonly torque: Vec3; }

export function resultantThrust(
  engines: readonly EngineThrustVector[], throttles: readonly number[], centerOfMass: Vec3,
): ResultantThrust {
  if (engines.length !== throttles.length) throw new RangeError('engine/throttle count mismatch');
  let force = v3();
  let torque = v3();
  for (let i = 0; i < engines.length; i += 1) {
    const e = engines[i]!;
    const throttle = Math.max(0, Math.min(1, throttles[i]!));
    const f = scale(norm(e.direction), e.maxThrust * throttle);
    force = add(force, f);
    torque = add(torque, cross(sub(e.position, centerOfMass), f));
  }
  return { force, torque };
}

export function gimbalCorrection(
  engines: readonly EngineThrustVector[], request: readonly number[], dt: number,
): readonly number[] {
  if (engines.length !== request.length) throw new RangeError('engine/request count mismatch');
  if (dt < 0) throw new RangeError('dt must be non-negative');
  return engines.map((engine, i) => {
    const limit = Math.abs(engine.gimbalRangeDeg);
    const maxStep = Math.abs(engine.gimbalRateDegPerSecond) * dt;
    return Math.max(-limit, Math.min(limit, Math.max(-maxStep, Math.min(maxStep, request[i]!))));
  });
}
