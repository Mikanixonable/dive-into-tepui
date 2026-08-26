// 「どの天体を光源として扱うか」を決める。基準点へ届ける放射照度が強い順にスロット本数まで
// 返す。天体が枠から外れるのは、より明るい天体に追い越されたときだけ。
import { CelestialBody } from '../../physics/celestial-body';
import { Ephemeris } from '../../physics/ephemeris';
import { sunlitFactor } from '../../physics/shadow';
import { dot, len, sub, Vec3 } from '../../physics/vec3';
import { lightSourceAlbedoOf, rec709Luminance, type Albedo } from '../../render/celestial-albedo';
import {
  MAX_PLANET_LIGHT_SLOTS, lambertPhase, planetRadiance,
} from '../../render/pipeline/lighting/planet-light-source';
import { SUN_IRRADIANCE_1AU, sunIrradianceAtDistance } from '../../render/pipeline/sun-light';

// 光源として選ばれた天体 1 体。位置・半径は body(ECI)から読む。
export type PlanetLight = {
  readonly body: CelestialBody;
  // 一様球としての放射輝度(色つき)。位相(満ち欠け)と天体の食(sunlitFactor)も掛けてある。
  readonly radiance: Albedo;
};

// 表示時刻 displayTime に、基準点 reference(ECI)へ強く届く順に天体光源を
// MAX_PLANET_LIGHT_SLOTS 体まで返す。
export function selectPlanetLights(
  ephemeris: Ephemeris, displayTime: number, reference: Vec3,
): readonly PlanetLight[] {
  const bodies = ephemeris.celestialBodiesAt(displayTime);
  const star = bodies.find((body) => body.isStar) ?? null;
  const candidates: { readonly light: PlanetLight; readonly irradiance: number }[] = [];
  for (const body of bodies) {
    if (body.isStar || body.radius <= 0) continue;
    const albedo = lightSourceAlbedoOf(body.id);
    // 主星の無いレジストリでは、全天体が 1 天文単位相当の明るさで満相のまま照らされていると
    // みなす(environment-scene.ts が恒星方向へ置く仮の光源と同じ目盛り)。
    const toSun = star === null ? null : sub(star.state.r, body.state.r);
    const sunIrradiance = toSun === null ? SUN_IRRADIANCE_1AU : sunIrradianceAtDistance(len(toSun));
    const toReference = sub(reference, body.state.r);
    const dist = Math.max(len(toReference), body.radius);
    // 位相角: 天体から見た太陽と基準点のなす角。
    const phase = toSun === null
      ? 1 : lambertPhase(Math.acos(Math.min(1, Math.max(-1, dot(toSun, toReference) / (len(toSun) * dist)))));
    const sunlit = star === null ? 1 : sunlitFactor(body.state.r, star, bodies.filter((b) => b !== body));
    const base = planetRadiance(albedo, sunIrradiance);
    const scale = phase * sunlit;
    const irradiance = Math.PI * rec709Luminance(base) * (body.radius / dist) ** 2 * scale;
    candidates.push({
      light: { body, radiance: [base[0] * scale, base[1] * scale, base[2] * scale] },
      irradiance,
    });
  }
  return candidates
    .sort((a, b) => b.irradiance - a.irradiance)
    .slice(0, MAX_PLANET_LIGHT_SLOTS)
    .map(({ light }) => light);
}
