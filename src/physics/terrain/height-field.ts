import { cross, norm, v3, type Vec3 } from '../vec3';

export const MOON_RADIUS = 1_737_400;
const TWO_PI = Math.PI * 2;

function hash(lat: number, lon: number, seed: number): number {
  const value = Math.sin(lat * 127.1 + lon * 311.7 + seed * 74.2) * 43758.5453;
  return value - Math.floor(value);
}
function smoothNoise(lat: number, lon: number, scale: number, seed: number): number {
  const y = lat / scale; const x = lon / scale;
  const x0 = Math.floor(x); const y0 = Math.floor(y); const tx = x - x0; const ty = y - y0;
  const fade = (t: number): number => t * t * (3 - 2 * t);
  const a = hash(y0, x0, seed); const b = hash(y0, x0 + 1, seed); const c = hash(y0 + 1, x0, seed); const d = hash(y0 + 1, x0 + 1, seed);
  const u = fade(tx); const v = fade(ty);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

/** Deterministic lunar height field: coarse spherical terrain plus polar basin/ridge terms. */
export function heightAt(bodyId: string, latRad: number, lonRad: number): number {
  if (bodyId !== 'moon') return 0;
  const coarse = (smoothNoise(latRad, lonRad, 0.35, 1) - 0.5) * 1800;
  const detail = (smoothNoise(latRad, lonRad, 0.035, 2) - 0.5) * 260;
  const southPole = Math.max(0, (-latRad - 1.25) / 0.32);
  const crater = Math.exp(-(((latRad + 1.48) / 0.12) ** 2 + (Math.atan2(Math.sin(lonRad + 0.3), Math.cos(lonRad + 0.3)) / 0.2) ** 2));
  const ridge = Math.exp(-(((latRad + 1.38) / 0.06) ** 2 + (Math.atan2(Math.sin(lonRad + 0.3), Math.cos(lonRad + 0.3)) / 0.25) ** 2));
  return coarse * (1 - southPole * 0.35) + detail - crater * 1800 + ridge * 900;
}

export function normalAt(bodyId: string, latRad: number, lonRad: number): Vec3 {
  if (bodyId !== 'moon') return v3(Math.cos(latRad) * Math.cos(lonRad), Math.sin(latRad), Math.cos(latRad) * Math.sin(lonRad));
  const d = 1e-5;
  const p0 = surfacePointAt(bodyId, latRad - d, lonRad); const p1 = surfacePointAt(bodyId, latRad + d, lonRad);
  const q0 = surfacePointAt(bodyId, latRad, lonRad - d); const q1 = surfacePointAt(bodyId, latRad, lonRad + d);
  return norm(cross(v3(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z), v3(q1.x - q0.x, q1.y - q0.y, q1.z - q0.z)));
}

export function surfacePointAt(bodyId: string, latRad: number, lonRad: number): Vec3 {
  const radius = MOON_RADIUS + heightAt(bodyId, latRad, lonRad);
  return v3(radius * Math.cos(latRad) * Math.cos(lonRad), radius * Math.sin(latRad), radius * Math.cos(latRad) * Math.sin(lonRad));
}

export function terrainLongitude(lonRad: number): number { return ((lonRad + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI; }
