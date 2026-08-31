// 「どの天体を光源として扱うか」を決める。基準点へ届ける放射照度が強い順にスロット本数まで
// 返す。天体が枠から外れるのは、より明るい天体に追い越されたときだけ。
import { lambertPhase } from '../../../physics/lambert-sphere';
import { sunlitFactor } from '../../../physics/shadow';
import { dot, len, sub } from '../../../math/vec3';
import { rec709Luminance } from '../../celestial-albedo';
import { MAX_PLANET_LIGHT_SLOTS, planetRadiance } from './planet-light-source';
import { SUN_IRRADIANCE_1AU, irradianceAtDistance } from '../sun-light';
import { CelestialMotion } from '../../../physics/celestial-motion';
import type { Vec3 } from '../../../math/vec3';
import type { Albedo } from '../../celestial-albedo';

// 光源になりうる天体 1 体。**恒星や半径 0 の天体を含む星系の全天体を渡すこと** — 天体自身の
// 食(sunlitFactor)が、光源にならない天体にも遮られるため。albedo は色つきのボンドアルベド。
export type PlanetLightCandidate = {
  readonly celestialBody: CelestialMotion;
  readonly albedo: Albedo;
};

// 光源として選ばれた天体 1 体。位置・半径は celestialBody(ECI)から読む。
export type PlanetLight = {
  readonly celestialBody: CelestialMotion;
  // 一様球としての放射輝度(色つき)。位相(満ち欠け)と天体の食(sunlitFactor)も掛けてある。
  readonly radiance: Albedo;
};

// 基準点 reference(ECI)へ強く届く順に天体光源を MAX_PLANET_LIGHT_SLOTS 体まで返す。
// starIntensity は主星の放射強度で、主星を持たない星系では null。
export function selectPlanetLights(
  candidates: readonly PlanetLightCandidate[], pivot: number, starIntensity: number | null,
  reference: Vec3,
): readonly PlanetLight[] {
  const bodies = candidates.map(({ celestialBody }) => celestialBody);
  const star = bodies.find((body) => body.kind === 'star') ?? null;
  const scored: { readonly light: PlanetLight; readonly irradiance: number }[] = [];
  for (const { celestialBody, albedo } of candidates) {
    if (celestialBody.kind === 'star' || celestialBody.def.radius <= 0) continue;
    const pos = celestialBody.positionAt(pivot, pivot);
    // 主星の無い星系では、全天体が 1 天文単位相当の明るさで満相のまま照らされているとみなす。
    const toSun = star === null ? null : sub(star.positionAt(pivot, pivot), pos);
    const sunIrradiance = toSun === null || starIntensity === null
      ? SUN_IRRADIANCE_1AU : irradianceAtDistance(starIntensity, len(toSun));
    const toReference = sub(reference, pos);
    const dist = Math.max(len(toReference), celestialBody.def.radius);
    // 位相角: 天体から見た主星と基準点のなす角。
    const cosAlpha = toSun === null ? 1 : dot(toSun, toReference) / (len(toSun) * dist);
    const phase = lambertPhase(Math.acos(Math.min(1, Math.max(-1, cosAlpha))));
    const sunlit = star === null
      ? 1 : sunlitFactor(pos, star, bodies.filter((b) => b !== celestialBody), pivot);
    const base = planetRadiance(albedo, sunIrradiance);
    const scale = phase * sunlit;
    const irradiance = Math.PI * rec709Luminance(base) * (celestialBody.def.radius / dist) ** 2 * scale;
    scored.push({
      light: { celestialBody, radiance: [base[0] * scale, base[1] * scale, base[2] * scale] },
      irradiance,
    });
  }
  return scored
    .sort((a, b) => b.irradiance - a.irradiance)
    .slice(0, MAX_PLANET_LIGHT_SLOTS)
    .map(({ light }) => light);
}
