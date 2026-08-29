// ECI 位置から最寄りの登録惑星までの距離と、マップ用の距離フェードを求める。
import type { CelestialBody } from '../../physics/celestial-body';
import { Vec3 } from '../../math/vec3';
import type { CelestialSystem } from './celestial-system';

const MAP_PLANET_SHIP_LABEL_START = 5e8;
const MAP_PLANET_SHIP_LABEL_END = 1e9;

type NearestPlanet = { readonly celestialBody: CelestialBody; readonly distance: number };

function findNearestPlanet(
  position: Vec3, celestialSystem: CelestialSystem, celestialBodies: readonly CelestialBody[],
): NearestPlanet | null {
  let nearest: NearestPlanet | null = null;
  for (const celestialBody of celestialBodies) {
    if (celestialSystem.find(celestialBody.id)?.motion.kind !== 'planet') continue;
    const dx = position.x - celestialBody.state.r.x;
    const dy = position.y - celestialBody.state.r.y;
    const dz = position.z - celestialBody.state.r.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (nearest === null || distance < nearest.distance) nearest = { celestialBody, distance };
  }
  return nearest;
}

export function nearestPlanetDistance(
  position: Vec3, celestialSystem: CelestialSystem, celestialBodies: readonly CelestialBody[],
): number | null {
  return findNearestPlanet(position, celestialSystem, celestialBodies)?.distance ?? null;
}

export function mapPlanetFadeOpacity(distance: number | null): number {
  if (distance === null) return 1;
  if (distance >= MAP_PLANET_SHIP_LABEL_END) return 0;
  return Math.max(0, Math.min(1, (MAP_PLANET_SHIP_LABEL_END - distance)
    / (MAP_PLANET_SHIP_LABEL_END - MAP_PLANET_SHIP_LABEL_START)));
}
