// 「どの天体を光源として扱うか」を決める。基準点へ届ける放射照度が、露出まで通しても
// 8bit sRGB の最小段を動かせない天体を捨て、残りを強い順にスロット本数まで返す。
// 閾値を割った瞬間の切り替わりが 1 LSB 未満であることは式そのものが保証するので、
// ヒステリシスは持たない。
import { CelestialBody } from '../../physics/celestial-body';
import { Ephemeris } from '../../physics/ephemeris';
import { sunlitFactor } from '../../physics/shadow';
import { len, sub, Vec3 } from '../../physics/vec3';
import { lightSourceAlbedoOf, rec709Luminance, type Albedo } from '../../render/celestial-albedo';
import { PLANET_LIGHT_SLOTS, planetRadiance } from '../../render/pipeline/lighting/planet-light-source';
import { SUN_IRRADIANCE_1AU, sunIrradianceAtDistance } from '../../render/pipeline/sun-light';

// 8bit sRGB の最小段(符号値 1/255 → 線形 3.04e-4)。トーンカーブ(Khronos PBR Neutral)の
// 傾きは全域で 1 以下なので、露出後の放射照度の増分がこれを下回る光源は、アルベド 1 の面でも
// 画面のどの画素も 1 LSB 動かせない。
const MIN_DISPLAY_STEP = 3.0e-4;

// 光源として選ばれた天体 1 体。位置・半径は body(ECI)から読む。
export type PlanetLight = {
  readonly body: CelestialBody;
  // 一様球としての放射輝度(色つき)。天体の食(sunlitFactor)も掛けてある。
  readonly radiance: Albedo;
};

// 表示時刻 displayTime に、基準点 reference(ECI)から見て絵に効く天体光源を強い順に
// PLANET_LIGHT_SLOTS 体まで返す。exposureFactor は露出係数(順応 × 露出補正)の数値。
export function selectPlanetLights(
  ephemeris: Ephemeris, displayTime: number, reference: Vec3, exposureFactor: number,
): readonly PlanetLight[] {
  const bodies = ephemeris.celestialBodiesAt(displayTime);
  const star = bodies.find((body) => body.isStar) ?? null;
  const threshold = (MIN_DISPLAY_STEP * SUN_IRRADIANCE_1AU) / exposureFactor;
  const candidates: { readonly light: PlanetLight; readonly irradiance: number }[] = [];
  for (const body of bodies) {
    if (body.isStar || body.radius <= 0) continue;
    const albedo = lightSourceAlbedoOf(body.id);
    // 主星の無いレジストリでは、全天体が 1 天文単位相当の明るさで照らされているとみなす
    // (environment-scene.ts が恒星方向へ置く仮の光源と同じ目盛り)。
    const sunIrradiance = star === null
      ? SUN_IRRADIANCE_1AU : sunIrradianceAtDistance(len(sub(star.state.r, body.state.r)));
    const radiance = planetRadiance(albedo, sunIrradiance);
    const dist = Math.max(len(sub(body.state.r, reference)), body.radius);
    const sinSqr = (body.radius / dist) ** 2;
    // まず食を見ない上限で当てる。食は減らす一方なので、ここで落ちる天体の食は見なくてよい。
    const bound = Math.PI * rec709Luminance(radiance) * sinSqr;
    if (bound < threshold) continue;
    const sunlit = star === null ? 1 : sunlitFactor(body.state.r, star, bodies.filter((b) => b !== body));
    const irradiance = bound * sunlit;
    if (irradiance < threshold) continue;
    candidates.push({
      light: { body, radiance: [radiance[0] * sunlit, radiance[1] * sunlit, radiance[2] * sunlit] },
      irradiance,
    });
  }
  return candidates
    .sort((a, b) => b.irradiance - a.irradiance)
    .slice(0, PLANET_LIGHT_SLOTS)
    .map(({ light }) => light);
}
