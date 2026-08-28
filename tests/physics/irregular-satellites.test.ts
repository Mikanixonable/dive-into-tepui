// 木星の不規則衛星6つとネレイドの回帰テスト: JPL 公開値との公転周期の一致、逆行の符号、
// 歳差なし(satelliteOrbit の 0 変換)、およびネレイド(高離心率)のケプラー往復精度。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { SatelliteDef } from '../../src/physics/celestial-motion';
import { ECL_POLE_ECI } from '../../src/physics/ecliptic';
import { keplerOrbitState } from '../../src/physics/kepler-orbit';
import { SatelliteOrbit } from '../../src/physics/satellite-orbit';
import { solarSystemEphemeris } from './test-helpers';
import { cross, dot, len, scale, sub } from '../../src/math/vec3';

// id から静的事実を引くための天体暦。
const DEFS = solarSystemEphemeris();

// テスト対象の id が衛星であることを前提に軌道モデルを取り出す。
function satelliteOrbitOf(id: string): SatelliteOrbit {
  return (DEFS.motionOf(id).def as SatelliteDef).orbit;
}
function planetOf(id: string): string {
  return DEFS.motionOf(id).primary!.id;
}

// [id, JPL 公開周期(日), 逆行か]。
const CASES: readonly [string, number, boolean][] = [
  ['himalia', 249.9090, false],
  ['elara', 258.8861, false],
  ['ananke', 623.1097, true],
  ['carme', 719.2806, true],
  ['pasiphae', 734.4215, true],
  ['sinope', 744.5951, true],
  ['nereid', 360.133039, false],
];

export function register(): void {
  const eph = solarSystemEphemeris({});

  test('irregular-satellites: 公転周期(lRate)が JPL の公開周期(日)と一致する', () => {
    for (const [id, periodDays] of CASES) {
      const lRate = satelliteOrbitOf(id).kepler.lRate;
      const expected = (2 * Math.PI) / (periodDays * 86400);
      assert.ok(Math.abs(lRate / expected - 1) < 1e-12, `${id} の lRate: ${lRate} vs ${expected}`);
    }
  });

  test('irregular-satellites: 傾斜角どおりの向きに公転する(逆行4体は角運動量が黄道極と逆向き)', () => {
    for (const [id, , retrograde] of CASES) {
      const planet = planetOf(id);
      const t = 1e7;
      const rel = sub(eph.stateOf(id, t).r, eph.stateOf(planet, t).r);
      const relVel = sub(eph.stateOf(id, t).v, eph.stateOf(planet, t).v);
      const h = cross(rel, relVel);
      const sign = dot(h, ECL_POLE_ECI);
      if (retrograde) assert.ok(sign < 0, `${id} が順行している: ${sign}`);
      else assert.ok(sign > 0, `${id} が逆行している: ${sign}`);
    }
  });

  test('irregular-satellites: 歳差周期が未測定(0)の変換により raanRate/lonPeriRate がちょうど0になる', () => {
    for (const [id] of CASES) {
      const kepler = satelliteOrbitOf(id).kepler;
      assert.equal(kepler.raanRate, 0, `${id} の raanRate`);
      assert.equal(kepler.lonPeriRate, 0, `${id} の lonPeriRate`);
    }
  });

  test('irregular-satellites: ネレイド(e=0.751)の keplerOrbitState は位置の中心差分と速度が一致する(相対1e-6)', () => {
    const orbit = satelliteOrbitOf('nereid').kepler;
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
}
