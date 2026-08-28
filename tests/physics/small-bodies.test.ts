// 太陽を公転する小天体32個の回帰テスト: lRate がケプラー第3法則と一致すること、
// セドナ(高離心率)のケプラー往復精度、離心率・半径の妥当性、celestialBodiesAt からの取得。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { Ephemeris, EPOCH_T_OFFSET } from '../../src/physics/ephemeris';
import { bodyDef, CelestialBodyDef, MU_SUN, SOLAR_SYSTEM } from '../../src/physics/solar-system';
import { keplerPeriod } from '../../src/physics/elements';
import { keplerOrbitState } from '../../src/physics/kepler-orbit';
import { PlanetOrbit } from '../../src/physics/planet-orbit';
import { len, scale, sub } from '../../src/math/vec3';

function planetOrbitOf(id: string): PlanetOrbit {
  return (bodyDef(SOLAR_SYSTEM, id) as Extract<CelestialBodyDef, { kind: 'planet' }>).orbit;
}

const SMALL_BODY_IDS: readonly string[] = [
  'sedna', 'quaoar', 'chariklo', 'hygiea', 'eros', 'ryugu', 'bennu',
  'orcus', 'gonggong', 'salacia', 'varuna', 'ixion', 'arrokoth', 'chiron', 'interamnia',
  'europa52', 'davida', 'juno', 'psyche', 'eunomia', 'sylvia', 'apophis',
  'didymos', 'tempel1', 'wild2', 'hartley2', 'cruithne', 'kamooalewa', 'tk7', 'eureka',
];

export function register(): void {
  const eph = new Ephemeris(SOLAR_SYSTEM, 'earth', EPOCH_T_OFFSET, {});

  test('small-bodies: lRate がケプラー第3法則から導いた値と一致する', () => {
    for (const id of SMALL_BODY_IDS) {
      const orbit = planetOrbitOf(id);
      const expected = (2 * Math.PI) / keplerPeriod(orbit.a, MU_SUN);
      assert.ok(Math.abs(orbit.lRate / expected - 1) < 1e-12, `${id} の lRate: ${orbit.lRate} vs ${expected}`);
    }
  });

  test('small-bodies: セドナ(e=0.860)の keplerOrbitState は位置の中心差分と速度が一致する(相対1e-6)', () => {
    const orbit = planetOrbitOf('sedna');
    const period = (2 * Math.PI) / orbit.lRate;
    const dt = period / 100000;
    for (let i = 0; i < 10; i++) {
      const t = (i / 10) * period;
      const s = keplerOrbitState(orbit, t, 0);
      const sPlus = keplerOrbitState(orbit, t + dt, 0);
      const sMinus = keplerOrbitState(orbit, t - dt, 0);
      const vFd = scale(sub(sPlus.r, sMinus.r), 1 / (2 * dt));
      const relErr = len(sub(vFd, s.v)) / len(s.v);
      assert.ok(relErr < 1e-6, `速度と位置の中心差分の不一致 (t=${t}): ${relErr}`);
    }
  });

  test('small-bodies: 離心率がすべて楕円ケプラーソルバの前提(<0.98)を満たす', () => {
    for (const id of SMALL_BODY_IDS) {
      const orbit = planetOrbitOf(id);
      assert.ok(orbit.e < 0.98, `${id} の e: ${orbit.e}`);
    }
  });

  test('small-bodies: 半径が有限で正、shape を持つ体では外接球になっている', () => {
    for (const id of SMALL_BODY_IDS) {
      const def = bodyDef(SOLAR_SYSTEM, id) as Extract<CelestialBodyDef, { kind: 'planet' }>;
      assert.ok(Number.isFinite(def.radius) && def.radius > 0, `${id} の radius`);
      if (def.shape !== undefined && def.shape.kind === 'triaxial') {
        const maxAxis = Math.max(def.shape.a, def.shape.b, def.shape.c);
        assert.ok(def.radius >= maxAxis, `${id} の radius が三軸の最長半軸を下回る: ${def.radius} < ${maxAxis}`);
      }
    }
  });

  test('small-bodies: celestialBodiesAt から32体すべてが取れ、太陽からの距離が有限で正', () => {
    const celestialBodies = eph.celestialBodiesAt(1e7);
    const sun = celestialBodies.find((a) => a.id === 'sun')!;
    for (const id of SMALL_BODY_IDS) {
      const a = celestialBodies.find((x) => x.id === id);
      assert.ok(a !== undefined, `${id} が celestialBodiesAt に無い`);
      const dist = len(sub(a!.state.r, sun.state.r));
      assert.ok(Number.isFinite(dist) && dist > 0, `${id} の太陽からの距離`);
    }
  });
}
