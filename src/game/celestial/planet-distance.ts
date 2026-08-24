// ECI 位置から最寄りの登録惑星までの距離と、マップ用の距離フェードを求める。
import type { CelestialBody } from '../../physics/celestial-body';
import { Vec3 } from '../../physics/vec3';
import type { CelestialRegistry } from '../../physics/solar-system';
import { bodyDef } from '../../physics/solar-system';
import * as C from '../const';

export type NearestPlanet = { readonly celestialBody: CelestialBody; readonly distance: number };

export function findNearestPlanet(
  position: Vec3, registry: CelestialRegistry, celestialBodies: readonly CelestialBody[],
): NearestPlanet | null {
  let nearest: NearestPlanet | null = null;
  for (const celestialBody of celestialBodies) {
    if (registry[celestialBody.id] === undefined || bodyDef(registry, celestialBody.id).kind !== 'planet') continue;
    const dx = position.x - celestialBody.state.r.x;
    const dy = position.y - celestialBody.state.r.y;
    const dz = position.z - celestialBody.state.r.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (nearest === null || distance < nearest.distance) nearest = { celestialBody, distance };
  }
  return nearest;
}

export function nearestPlanetDistance(
  position: Vec3, registry: CelestialRegistry, celestialBodies: readonly CelestialBody[],
): number | null {
  return findNearestPlanet(position, registry, celestialBodies)?.distance ?? null;
}

export function mapPlanetFadeOpacity(distance: number | null): number {
  if (distance === null) return 1;
  if (distance >= C.MAP_PLANET_SHIP_LABEL_END) return 0;
  return Math.max(0, Math.min(1, (C.MAP_PLANET_SHIP_LABEL_END - distance)
    / (C.MAP_PLANET_SHIP_LABEL_END - C.MAP_PLANET_SHIP_LABEL_START)));
}
