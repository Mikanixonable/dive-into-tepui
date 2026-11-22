// planet-light-select.ts の回帰テスト。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { fixedMotion } from '../physics/test-helpers';
import { selectPlanetLights } from '../../src/render/pipeline/lighting/planet-light-select';
import { MAX_PLANET_LIGHT_SLOTS, planetRadiance } from '../../src/render/pipeline/lighting/planet-light-source';
import { irradianceAtDistance, scaledRadiantIntensity } from '../../src/render/pipeline/sun-light';
import { rec709Luminance } from '../../src/render/celestial/celestial-albedo';
import { lambertPhase } from '../../src/physics/lambert-sphere';
import { sunlitFactor } from '../../src/physics/shadow';
import { isStar } from '../../src/physics/celestial-body-def';
import { AU, SOLAR_CONSTANT } from '../../src/physics/astronomical-unit';
import { kinematicState } from '../../src/physics/kinematic-state';
import { mulberry32 } from '../../src/math/random';
import { dot, len, sub, v3, type Vec3 } from '../../src/math/vec3';
import type { CelestialMotion } from '../../src/physics/celestial-motion';
import type { Albedo } from '../../src/render/celestial/celestial-albedo';

interface Candidate {
  readonly celestialBody: CelestialMotion;
  readonly albedo: Albedo;
}

// 全候補の日照率まで解いてから、明るい順(同点は並び順)に枠の数だけ取る、選択の定義そのもの。
function selectByFullEvaluation(candidates: readonly Candidate[], pivot: number, reference: Vec3): readonly {
  readonly celestialBody: CelestialMotion; readonly radiance: Albedo; readonly sunIrradiance: number;
}[] {
  const bodies = candidates.map((c) => c.celestialBody);
  const star = bodies.find(isStar)!;
  const intensity = scaledRadiantIntensity(star.def.radiantIntensity);
  const scored = [];
  for (const { celestialBody, albedo } of candidates) {
    if (celestialBody.kind === 'star' || celestialBody.def.radius <= 0) continue;
    const pos = celestialBody.positionAt(pivot);
    const toSun = sub(star.positionAt(pivot), pos);
    const sunIrradiance = irradianceAtDistance(intensity, len(toSun));
    const toReference = sub(reference, pos);
    const dist = Math.max(len(toReference), celestialBody.def.radius);
    const cosAlpha = dot(toSun, toReference) / (len(toSun) * dist);
    const phase = lambertPhase(Math.acos(Math.min(1, Math.max(-1, cosAlpha))));
    const sunlit = sunlitFactor(pos, star, bodies.filter((b) => b !== celestialBody), pivot);
    const base = planetRadiance(albedo, sunIrradiance);
    const irradiance = Math.PI * rec709Luminance(base) * (celestialBody.def.radius / dist) ** 2 * phase * sunlit;
    scored.push({
      light: {
        celestialBody,
        radiance: [base[0] * sunlit, base[1] * sunlit, base[2] * sunlit] as Albedo,
        sunIrradiance: sunIrradiance * sunlit,
      },
      irradiance,
    });
  }
  return scored.sort((a, b) => b.irradiance - a.irradiance).slice(0, MAX_PLANET_LIGHT_SLOTS).map((s) => s.light);
}

// position [m] に静止した半径 radius [m] の天体。恒星なら太陽と同じ放射強度を持つ。
function motionAt(id: string, radius: number, position: Vec3, kind: 'star' | 'planet' = 'planet'): CelestialMotion {
  return fixedMotion({
    id, mu: 1, radius, state: kinematicState<'eci'>(0, position, v3(0, 0, 0)), kind,
    radiantIntensity: kind === 'star' ? SOLAR_CONSTANT * AU * AU : 0,
  });
}

export function register(): void {
  test('planet-light-select: 上界で打ち切った選択は全候補を解いた選択と一致する(食と同点を含む)', () => {
    const random = mulberry32(20261122);
    for (let trial = 0; trial < 200; trial++) {
      const star = motionAt('star', 6.957e8, v3(AU, 0, 0), 'star');
      const candidates: Candidate[] = [{ celestialBody: star, albedo: [0, 0, 0] }];
      const count = 2 + Math.floor(random() * 10);
      for (let i = 0; i < count; i++) {
        // 半数は先に置いた天体の反太陽側の近くへ置き、食を起こす。
        const previous = candidates.at(-1)!.celestialBody;
        const near = i > 0 && random() < 0.5;
        const radius = random() < 0.1 ? 0 : 1e5 + random() * 6e6;
        const position = near
          ? v3(previous.positionAt(0).x - 1e7 - random() * 1e8, previous.positionAt(0).y + (random() - 0.5) * 1e7, 0)
          : v3((random() - 0.5) * 4e9, (random() - 0.5) * 4e9, (random() - 0.5) * 1e9);
        // 同点を作るため、ときどき直前と同じ半径・位置・反射率の天体を並べる。
        const duplicate = i > 0 && random() < 0.15;
        const albedo: Albedo = duplicate ? candidates.at(-1)!.albedo : [random(), random(), random()];
        candidates.push({
          celestialBody: duplicate
            ? motionAt(`b${i}`, previous.def.radius, previous.positionAt(0))
            : motionAt(`b${i}`, radius, position),
          albedo,
        });
      }
      const reference = v3((random() - 0.5) * 2e9, (random() - 0.5) * 2e9, 0);
      const expected = selectByFullEvaluation(candidates, 0, reference);
      const actual = selectPlanetLights(candidates, 0, reference);
      assert.equal(actual.length, expected.length, `trial ${trial}: 枠の数`);
      for (const [i, light] of actual.entries()) {
        assert.equal(light.celestialBody, expected[i]!.celestialBody, `trial ${trial}: ${i} 番目の天体`);
        assert.deepEqual(light.radiance, expected[i]!.radiance, `trial ${trial}: ${i} 番目の放射輝度`);
        assert.equal(light.sunIrradiance, expected[i]!.sunIrradiance, `trial ${trial}: ${i} 番目の放射照度`);
      }
    }
  });
}
