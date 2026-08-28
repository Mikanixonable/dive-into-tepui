// 木星系・土星系の衛星23個の回帰テスト: JPL 公開値との公転周期・歳差周期の一致、歳差なし変換、
// フェーベの逆行、内側衛星の基準面が黄道面ではなくラプラス面であること、および外側の
// イアペトゥス・フェーベの黄道傾斜が公表値と合うこと。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { Ephemeris, EPOCH_T_OFFSET } from '../../src/physics/ephemeris';
import { bodyDef, CelestialBodyDef, SOLAR_SYSTEM } from '../../src/physics/solar-system';
import { ECL_POLE_ECI, raDecToEci } from '../../src/physics/ecliptic';
import { SatelliteOrbit } from '../../src/physics/satellite-orbit';
import { keplerOrbitState } from '../../src/physics/kepler-orbit';
import { cross, dot, len, norm, sub } from '../../src/math/vec3';

function satelliteOrbitOf(id: string): SatelliteOrbit {
  return (bodyDef(SOLAR_SYSTEM, id) as Extract<CelestialBodyDef, { kind: 'satellite' }>).orbit;
}
function planetOf(id: string): string {
  return (bodyDef(SOLAR_SYSTEM, id) as Extract<CelestialBodyDef, { kind: 'satellite' }>).planet;
}

const JULIAN_YEAR_DAYS = 365.25;

// [id, JPL 公開周期(日)]。
const CASES: readonly [string, number][] = [
  ['metis', 0.294779],
  ['adrastea', 0.298260],
  ['amalthea', 0.499918],
  ['thebe', 0.676105],
  ['pan', 0.575051],
  ['daphnis', 0.594080],
  ['prometheus', 0.615878],
  ['pandora', 0.631369],
  ['epimetheus', 0.697012],
  ['janus', 0.697353],
  ['mimas', 0.942422],
  ['enceladus', 1.370218],
  ['tethys', 1.887802],
  ['dione', 2.736916],
  ['rhea', 4.517503],
  ['hyperion', 21.276658],
  ['iapetus', 79.331002],
  ['phoebe', 550.303910],
  // 同じラプラス面を基準面とする既存のガリレオ衛星・タイタン。
  ['io', 1.762732],
  ['europa', 3.525463],
  ['ganymede', 7.155588],
  ['callisto', 16.690440],
  ['titan', 15.945448],
];

// [id, 昇交点歳差周期(年), 近点歳差周期(年)]。0 は「歳差しない」。
const PRECESSION: readonly [string, number, number][] = [
  ['io', 0, 1.333],
  ['europa', 30.202, 1.394],
  ['ganymede', 137.812, 68.301],
  ['callisto', 577.264, 277.921],
  ['titan', 687.370, 346.680],
  ['mimas', 0.986, 0.493],
  ['enceladus', 0, 2.916],
  ['tethys', 4.982, 0.005],
  ['dione', 0, 11.698],
  ['rhea', 35.775, 33.939],
];

// 歳差周期が公開されていない(= 0)体。
const NO_PRECESSION: readonly string[] = [
  'metis', 'adrastea', 'amalthea', 'thebe',
  'pan', 'daphnis', 'prometheus', 'pandora', 'epimetheus', 'janus',
  'hyperion', 'iapetus', 'phoebe',
];

// 土星の自転極(IAU、元期の値。SATURN_POLE と同じ出典)。
const SATURN_POLE_ECI = raDecToEci(40.589, 83.537);

function orbitNormal(eph: Ephemeris, id: string, planet: string, t: number) {
  const rel = sub(eph.stateOf(id, t).r, eph.stateOf(planet, t).r);
  const relVel = sub(eph.stateOf(id, t).v, eph.stateOf(planet, t).v);
  return norm(cross(rel, relVel));
}

export function register(): void {
  const eph = new Ephemeris(SOLAR_SYSTEM, 'earth', EPOCH_T_OFFSET, {});

  test('laplace-satellites: 公転周期(lRate)が JPL の公開周期(日)と一致する', () => {
    for (const [id, periodDays] of CASES) {
      const lRate = satelliteOrbitOf(id).kepler.lRate;
      const expected = (2 * Math.PI) / (periodDays * 86400);
      assert.ok(Math.abs(lRate / expected - 1) < 1e-12, `${id} の lRate: ${lRate} vs ${expected}`);
    }
  });

  test('laplace-satellites: 公開されている歳差周期が、逆行する昇交点・順行する近点として入る', () => {
    for (const [id, nodeYears, apsisYears] of PRECESSION) {
      const kepler = satelliteOrbitOf(id).kepler;
      if (nodeYears === 0) {
        assert.equal(kepler.raanRate, 0, `${id} の raanRate`);
      } else {
        assert.ok(kepler.raanRate < 0, `${id} の昇交点歳差が逆行していない: ${kepler.raanRate}`);
        const years = (2 * Math.PI) / Math.abs(kepler.raanRate) / (JULIAN_YEAR_DAYS * 86400);
        assert.ok(Math.abs(years / nodeYears - 1) < 1e-9, `${id} の昇交点歳差周期: ${years}`);
      }
      if (apsisYears === 0) {
        assert.equal(kepler.lonPeriRate, 0, `${id} の lonPeriRate`);
      } else {
        assert.ok(kepler.lonPeriRate > 0, `${id} の近点歳差が順行していない: ${kepler.lonPeriRate}`);
        const years = (2 * Math.PI) / kepler.lonPeriRate / (JULIAN_YEAR_DAYS * 86400);
        assert.ok(Math.abs(years / apsisYears - 1) < 1e-9, `${id} の近点歳差周期: ${years}`);
      }
    }
  });

  test('laplace-satellites: 歳差周期が未測定(0)の変換により raanRate/lonPeriRate がちょうど0になる', () => {
    for (const id of NO_PRECESSION) {
      const kepler = satelliteOrbitOf(id).kepler;
      assert.equal(kepler.raanRate, 0, `${id} の raanRate`);
      assert.equal(kepler.lonPeriRate, 0, `${id} の lonPeriRate`);
    }
  });

  // テティスの近点歳差周期 0.005 年(1.83 日)は公転周期 1.888 日とほぼ同じで、近点が1公転に
  // つき1周する = 実質的に近点が定まらない円軌道であることを表す。出典の値を書き換えずに
  // 使えるのは、離心率 0.001 では近点がどこを向いても位置がほとんど変わらないため。
  test('laplace-satellites: テティスの位置は近点歳差の有無でほとんど変わらない', () => {
    const orbit = satelliteOrbitOf('tethys').kepler;
    const frozen = { ...orbit, lonPeriRate: 0 };
    const period = (2 * Math.PI) / orbit.lRate;
    let maxDiff = 0;
    for (let i = 0; i < 20; i++) {
      const t = (i / 20) * period;
      maxDiff = Math.max(maxDiff, len(sub(keplerOrbitState(orbit, t, 0).r, keplerOrbitState(frozen, t, 0).r)));
    }
    // 軌道長半径 295,000 km に対し、離心率ぶんの振れ幅(a·e ≈ 295 km)の数倍に収まる。
    assert.ok(maxDiff < 1200e3, `近点歳差の有無による位置差: ${maxDiff / 1e3} km`);
  });

  test('laplace-satellites: フェーベは土星の自転極に対しても黄道極に対しても逆行(角運動量が負の内積)', () => {
    const h = orbitNormal(eph, 'phoebe', 'saturn', 1e7);
    assert.ok(dot(h, SATURN_POLE_ECI) < 0, `土星の自転極に対して逆行していない: ${dot(h, SATURN_POLE_ECI)}`);
    assert.ok(dot(h, ECL_POLE_ECI) < 0, `黄道極に対して逆行していない: ${dot(h, ECL_POLE_ECI)}`);
  });

  // 外側の2衛星は局所ラプラス面が内側衛星の面と大きく異なるため黄道面基準で登録してある。
  // 内側衛星の面に載せると、この黄道傾斜が十数度ずれる。
  test('laplace-satellites: イアペトゥス・フェーベの黄道傾斜が公表値と一致する', () => {
    const eclipticIncDeg = (id: string, planet: string): number => {
      const h = orbitNormal(eph, id, planet, 0);
      return Math.acos(Math.min(1, Math.max(-1, dot(h, ECL_POLE_ECI)))) * (180 / Math.PI);
    };
    assert.ok(Math.abs(eclipticIncDeg('iapetus', 'saturn') - 17.28) < 0.2, `イアペトゥス: ${eclipticIncDeg('iapetus', 'saturn')}°`);
    assert.ok(Math.abs(eclipticIncDeg('phoebe', 'saturn') - 175.2) < 0.2, `フェーベ: ${eclipticIncDeg('phoebe', 'saturn')}°`);
  });

  // 内側衛星は土星の赤道面に近いラプラス面に載るので、黄道極からは土星の赤道傾斜ぶん離れる。
  test('laplace-satellites: 土星の内側衛星の基準面は黄道面ではなくラプラス面(ミマスの軌道法線が黄道極から26°以上離れる)', () => {
    const h = orbitNormal(eph, 'mimas', 'saturn', 1e7);
    const angleFromEclipticPoleDeg = Math.acos(Math.min(1, Math.max(-1, dot(h, ECL_POLE_ECI)))) * (180 / Math.PI);
    assert.ok(angleFromEclipticPoleDeg > 26, `黄道極からの角度: ${angleFromEclipticPoleDeg}°(黄道基準では成立しないはず)`);
  });

  test('laplace-satellites: 惑星が想定どおり(木星・土星)であることの確認', () => {
    assert.equal(planetOf('metis'), 'jupiter');
    assert.equal(planetOf('phoebe'), 'saturn');
  });

  test('laplace-satellites: 半径・重力定数が有限で正(ダフニスのみ mu=0)', () => {
    for (const [id] of CASES) {
      const def = bodyDef(SOLAR_SYSTEM, id) as Extract<CelestialBodyDef, { kind: 'satellite' }>;
      assert.ok(Number.isFinite(def.radius) && def.radius > 0, `${id} の radius`);
      if (id === 'daphnis') assert.equal(def.mu, 0);
      else assert.ok(Number.isFinite(def.mu) && def.mu > 0, `${id} の mu`);
    }
  });

  test('laplace-satellites: celestialBodiesAt から得られる位置が正の距離を持つ(有限性の smoke test)', () => {
    const celestialBodies = eph.celestialBodiesAt(1e7);
    for (const [id] of CASES) {
      const a = celestialBodies.find((x) => x.id === id)!;
      assert.ok(a !== undefined, `${id} が celestialBodiesAt に無い`);
      assert.ok(Number.isFinite(len(a.state.r)) && len(a.state.r) > 0, `${id} の距離`);
    }
  });
}
