// 天王星の衛星6個・冥王星の衛星5個・準惑星/小惑星の衛星5個(計16体)の回帰テスト:
// JPL 公開値との公転周期の一致、天王星系が黄道に対し横倒しであること、冥王星-カロンが
// 実際に連星(共通重心が冥王星本体の外側にある)であること、および登録天体がすべて μ を
// 持つこと。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  PlanetDef, planetDefForSimZero, satelliteDefForSimZero, PlanetMotion, SatelliteDef, SatelliteMotion, StarMotion,
} from '../../src/physics/celestial-motion';
import { EciTransform } from '../../src/physics/eci-transform';
import { planetSystem } from '../../src/physics/planet-system';
import { ECL_POLE_ECI } from '../../src/physics/ecliptic';
import { SatelliteOrbit } from '../../src/physics/satellite-orbit';
import { PLUTO } from '../../src/game/celestial/solar-system/dwarf-planets';
import { EARTH, MOON } from '../../src/game/celestial/solar-system/earth-system';
import { ORCUS, QUAOAR } from '../../src/game/celestial/solar-system/small-bodies';
import { SUN } from '../../src/game/celestial/solar-system/sun';
import { SolarSystemParts, motionOf, orbitingMotionOf, solarSystemParts, stateOf, TEST_SIM_ZERO_ET } from './test-helpers';
import { Vec3, add, cross, dot, len, norm, scale, sub } from '../../src/math/vec3';

// id から静的事実を引くための太陽系。
const DEFS = solarSystemParts();

// 衛星を1体も登録せずに組んだ primaryDef の惑星の、時刻 t での ECI 位置。原点(地球)側は
// 本来どおり月まで組む — 原点天体の日心位置がずれると ECI 位置の比較にならない。
function withoutSatellitePosition(primaryDef: PlanetDef, t: number): Vec3 {
  const sun = new StarMotion(SUN);
  const earth = planetSystem(planetDefForSimZero(EARTH, {}, TEST_SIM_ZERO_ET), sun);
  // 月は構築するだけで地球-月系の重心補正の対象として登録される。
  new SatelliteMotion(satelliteDefForSimZero(MOON, {}, TEST_SIM_ZERO_ET), earth);
  const bare = planetSystem(planetDefForSimZero(primaryDef, {}, TEST_SIM_ZERO_ET), sun);
  return new EciTransform(earth.body).stateAt(t, bare.body).r;
}

function satelliteOrbitOf(id: string): SatelliteOrbit {
  return (motionOf(DEFS, id).def as SatelliteDef).orbit;
}
function muOf(id: string): number {
  return motionOf(DEFS, id).def.mu;
}

// [id, JPL 公開周期(日)]。
const CASES: readonly [string, number][] = [
  ['puck', 0.761833],
  ['miranda', 1.413479],
  ['ariel', 2.520379],
  ['umbriel', 4.144177],
  ['titania', 8.705869],
  ['oberon', 13.463237],
  ['charon', 6.387222],
  ['styx', 20.16],
  ['nix', 24.85],
  ['kerberos', 32.17],
  ['hydra', 38.20],
  ['dysnomia', 15.785899],
  ['hiiaka', 49.462],
  ['namaka', 18.2783],
  ['vanth', 9.539154],
  ['weywot', 12.42727],
];

const URANUS_MOONS: readonly string[] = ['miranda', 'ariel', 'umbriel', 'titania', 'oberon'];

function orbitNormal(parts: SolarSystemParts, id: string, planet: string, t: number) {
  const satellite = stateOf(parts, id, t);
  const primary = stateOf(parts, planet, t);
  return norm(cross(sub(satellite.r, primary.r), sub(satellite.v, primary.v)));
}

export function register(): void {
  const parts = solarSystemParts({});

  test('equatorial-satellites: 公転周期(lRate)が JPL の公開周期(日)と一致する', () => {
    for (const [id, periodDays] of CASES) {
      const lRate = satelliteOrbitOf(id).kepler.lRate;
      const expected = (2 * Math.PI) / (periodDays * 86400);
      assert.ok(Math.abs(lRate / expected - 1) < 1e-12, `${id} の lRate: ${lRate} vs ${expected}`);
    }
  });

  test('equatorial-satellites: 天王星の衛星の軌道面は黄道極から90°以上離れている(自転軸97.8°の横倒しを反映)', () => {
    const t = 2e7;
    for (const id of URANUS_MOONS) {
      const n = orbitNormal(parts, id, 'uranus', t);
      const angleDeg = (Math.acos(Math.max(-1, Math.min(1, dot(n, ECL_POLE_ECI)))) * 180) / Math.PI;
      assert.ok(angleDeg > 90, `${id} の軌道面が黄道基準の傾斜角として計算されている疑い: ${angleDeg}°`);
    }
  });

  test('equatorial-satellites: 天王星の5衛星は互いにほぼ同一面(軌道法線どうしのなす角が5°未満)', () => {
    const t = 2e7;
    const normals = URANUS_MOONS.map((id) => orbitNormal(parts, id, 'uranus', t));
    for (let i = 1; i < normals.length; i++) {
      const angleDeg = (Math.acos(Math.max(-1, Math.min(1, dot(normals[0]!, normals[i]!)))) * 180) / Math.PI;
      assert.ok(angleDeg < 5, `${URANUS_MOONS[i]} の軌道面がミランダと揃っていない: ${angleDeg}°`);
    }
  });

  test('equatorial-satellites: 冥王星-カロンは連星(共通重心が冥王星の外側)', () => {
    const muPluto = muOf('pluto');
    const muCharon = muOf('charon');
    const periodSec = 6.387222 * 86400;
    let maxOffset = 0;
    const steps = 400;
    for (let i = 0; i < steps; i++) {
      const t = (periodSec * i) / steps;
      const rPluto = stateOf(parts, 'pluto', t).r;
      const rCharon = stateOf(parts, 'charon', t).r;
      const barycenter = scale(add(scale(rPluto, muPluto), scale(rCharon, muCharon)), 1 / (muPluto + muCharon));
      maxOffset = Math.max(maxOffset, len(sub(rPluto, barycenter)));
    }
    const maxOffsetKm = maxOffset / 1e3;
    assert.ok(Math.abs(maxOffsetKm - 2130) < 200, `共通重心までの振幅: ${maxOffsetKm} km`);
    const plutoRadiusKm = PLUTO.radius / 1e3;
    assert.ok(maxOffsetKm > plutoRadiusKm, '共通重心が冥王星本体の内側に収まっている(連星になっていない)');
  });

  // μ = 0 は「その天体の重力を無視すると宣言した」の意で、既定のレジストリはこの宣言を
  // 使わない。GM が実測されていない天体にも推定値を置く、という方針をここで押さえる。
  test('equatorial-satellites: 既定の登録天体はすべて μ を持つ', () => {
    for (const motion of DEFS.bodies) {
      assert.ok(Number.isFinite(motion.def.mu) && motion.def.mu > 0, `${motion.def.id} の μ`);
    }
  });

  // 衛星を持つ系の本体は、系重心から μ_衛星/μ_系 × 衛星距離ぶんずれた位置にある。本体と
  // 衛星の相対位置は衛星の有無で変わらないので、本体の日心位置を直に見ないと出ない。
  test('equatorial-satellites: 主天体は衛星ぶんの重心オフセットだけずれる', () => {
    for (const [primary, def, expectedKm] of
      [['quaoar', QUAOAR, 26.3], ['orcus', ORCUS, 1234]] as const) {
      const t = 1e6;
      const bare = withoutSatellitePosition(def, t);
      const movedKm = len(sub(stateOf(parts, primary, t).r, bare)) / 1e3;
      assert.ok(Math.abs(movedKm - expectedKm) < expectedKm * 0.05,
        `${primary} の重心オフセット: ${movedKm} km(期待 ${expectedKm} km)`);
    }
  });

  // 質量比が決まらないのは μ = 0 を含む系だけなので、既定のレジストリではどの系でも決まる。
  // ディディモスは質量比が 1e-19 台まで小さいので、「質量が小さい」ことと「質量比が
  // 決まらない」ことが混ざっていないかをここで分ける。
  test('equatorial-satellites: 質量の小さい天体でも質量比は決まる', () => {
    for (const id of ['quaoar', 'orcus', 'puck', 'styx', 'kerberos', 'didymos'] as const) {
      assert.equal(orbitingMotionOf(parts, id).hasStableTriangularPoints(), true, `${id} の三角点`);
    }
    assert.equal(orbitingMotionOf(parts, 'moon').hasUsableCollinearPoints(10), true, '地球-月の共線点');
    assert.equal(orbitingMotionOf(parts, 'moon').hasStableTriangularPoints(), true, '地球-月の三角点');
    assert.equal(orbitingMotionOf(parts, 'didymos').hasUsableCollinearPoints(10), true, '太陽-ディディモスの共線点');
  });
}
