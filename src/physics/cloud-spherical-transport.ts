// Exact spherical advection for a constant local tangent velocity [m/s]. The velocity
// direction is parallel-transported along the resulting great circle, so distance is
// radius × angular distance and no map projection or pole special case is involved.
// Spatially/time varying winds must be integrated by the caller with an explicit,
// reproducible quadrature rule; this function does not choose a visual timestep.

import { v3 } from '../math/vec3';
import type { Vec3 } from '../math/vec3';

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function normalized(vector: Vec3): Vec3 {
  const magnitude = Math.hypot(vector.x, vector.y, vector.z);
  if (magnitude === 0) throw new RangeError('positionUnitVector must not be zero');
  return v3(vector.x / magnitude, vector.y / magnitude, vector.z / magnitude);
}

// Maps one spherical position through the exponential map of its tangent plane.
// A radial component in tangentVelocityMPerS is rejected instead of silently discarded.
export function advectSphericalPositionUnitVector(
  positionUnitVector: Vec3,
  tangentVelocityMPerS: Vec3,
  sphereRadiusM: number,
  elapsedTimeS: number,
): Vec3 {
  requireFinite(positionUnitVector.x, 'positionUnitVector.x');
  requireFinite(positionUnitVector.y, 'positionUnitVector.y');
  requireFinite(positionUnitVector.z, 'positionUnitVector.z');
  requireFinite(tangentVelocityMPerS.x, 'tangentVelocityMPerS.x');
  requireFinite(tangentVelocityMPerS.y, 'tangentVelocityMPerS.y');
  requireFinite(tangentVelocityMPerS.z, 'tangentVelocityMPerS.z');
  requireFinite(sphereRadiusM, 'sphereRadiusM');
  requireFinite(elapsedTimeS, 'elapsedTimeS');
  if (sphereRadiusM <= 0) throw new RangeError('sphereRadiusM must be positive');

  const start = normalized(positionUnitVector);
  const radialVelocityMPerS = start.x * tangentVelocityMPerS.x
    + start.y * tangentVelocityMPerS.y
    + start.z * tangentVelocityMPerS.z;
  const velocityMagnitudeMPerS = Math.hypot(
    tangentVelocityMPerS.x,
    tangentVelocityMPerS.y,
    tangentVelocityMPerS.z,
  );
  if (Math.abs(radialVelocityMPerS) > Math.max(1e-12, velocityMagnitudeMPerS * 1e-12)) {
    throw new RangeError('tangentVelocityMPerS must be perpendicular to positionUnitVector');
  }
  if (velocityMagnitudeMPerS === 0 || elapsedTimeS === 0) return start;

  const angleRad = velocityMagnitudeMPerS * elapsedTimeS / sphereRadiusM;
  const directionX = tangentVelocityMPerS.x / velocityMagnitudeMPerS;
  const directionY = tangentVelocityMPerS.y / velocityMagnitudeMPerS;
  const directionZ = tangentVelocityMPerS.z / velocityMagnitudeMPerS;
  return normalized(v3(
    start.x * Math.cos(angleRad) + directionX * Math.sin(angleRad),
    start.y * Math.cos(angleRad) + directionY * Math.sin(angleRad),
    start.z * Math.cos(angleRad) + directionZ * Math.sin(angleRad),
  ));
}
