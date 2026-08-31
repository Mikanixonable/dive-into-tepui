// ECI 位置から最寄りの登録惑星までの距離と、マップ用の距離フェードを求める。
import { CelestialMotion } from '../../physics/celestial-motion';
import { Vec3 } from '../../math/vec3';

const MAP_PLANET_SHIP_LABEL_START = 5e8;
const MAP_PLANET_SHIP_LABEL_END = 1e9;

// position から最寄りの惑星までの距離 [m]。惑星が1体も無ければ null。
export function nearestPlanetDistance(
  position: Vec3, celestialBodies: readonly CelestialMotion[], pivot: number,
): number | null {
  let nearest: number | null = null;
  for (const celestialBody of celestialBodies) {
    if (celestialBody.kind !== 'planet') continue;
    const pos = celestialBody.positionAt(pivot);
    const dx = position.x - pos.x;
    const dy = position.y - pos.y;
    const dz = position.z - pos.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (nearest === null || distance < nearest) nearest = distance;
  }
  return nearest;
}

// 最寄り惑星までの距離に応じてマップ上の表示を薄める係数 0..1。距離が null なら 1(薄めない)。
export function mapPlanetFadeOpacity(distance: number | null): number {
  if (distance === null) return 1;
  if (distance >= MAP_PLANET_SHIP_LABEL_END) return 0;
  return Math.max(0, Math.min(1, (MAP_PLANET_SHIP_LABEL_END - distance)
    / (MAP_PLANET_SHIP_LABEL_END - MAP_PLANET_SHIP_LABEL_START)));
}
