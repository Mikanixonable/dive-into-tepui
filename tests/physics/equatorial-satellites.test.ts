// 天王星の衛星6個・冥王星の衛星5個・準惑星/小惑星の衛星5個(計16体)の回帰テスト:
// JPL 公開値との公転周期の一致、天王星系が黄道に対し横倒しであること、冥王星-カロンが
// 実際に連星(共通重心が冥王星本体の外側にある)であること、および未測定 GM が 0 として
// 登録されていること。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { Ephemeris, EPOCH_T_OFFSET } from '../../src/physics/ephemeris';
import { bodyDef, CelestialBodyDef, SOLAR_SYSTEM } from '../../src/physics/solar-system';
import { ECL_POLE_ECI } from '../../src/physics/ecliptic';
import { SatelliteOrbit } from '../../src/physics/satellite-orbit';
import { add, cross, dot, len, norm, scale, sub } from '../../src/math/vec3';

function satelliteOrbitOf(id: string): SatelliteOrbit {
  return (bodyDef(SOLAR_SYSTEM, id) as Extract<CelestialBodyDef, { kind: 'satellite' }>).orbit;
}
function planetOf(id: string): string {
  return (bodyDef(SOLAR_SYSTEM, id) as Extract<CelestialBodyDef, { kind: 'satellite' }>).planet;
}
function muOf(id: string): number {
  return bodyDef(SOLAR_SYSTEM, id).mu;
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

function orbitNormal(eph: Ephemeris, id: string, planet: string, t: number) {
  const rel = sub(eph.stateOf(id, t).r, eph.stateOf(planet, t).r);
  const relVel = sub(eph.stateOf(id, t).v, eph.stateOf(planet, t).v);
  return norm(cross(rel, relVel));
}

export function register(): void {
  const eph = new Ephemeris(SOLAR_SYSTEM, 'earth', EPOCH_T_OFFSET, {});

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
      const n = orbitNormal(eph, id, 'uranus', t);
      const angleDeg = (Math.acos(Math.max(-1, Math.min(1, dot(n, ECL_POLE_ECI)))) * 180) / Math.PI;
      assert.ok(angleDeg > 90, `${id} の軌道面が黄道基準の傾斜角として計算されている疑い: ${angleDeg}°`);
    }
  });

  test('equatorial-satellites: 天王星の5衛星は互いにほぼ同一面(軌道法線どうしのなす角が5°未満)', () => {
    const t = 2e7;
    const normals = URANUS_MOONS.map((id) => orbitNormal(eph, id, 'uranus', t));
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
      const rPluto = eph.stateOf('pluto', t).r;
      const rCharon = eph.stateOf('charon', t).r;
      const barycenter = scale(add(scale(rPluto, muPluto), scale(rCharon, muCharon)), 1 / (muPluto + muCharon));
      maxOffset = Math.max(maxOffset, len(sub(rPluto, barycenter)));
    }
    const maxOffsetKm = maxOffset / 1e3;
    assert.ok(Math.abs(maxOffsetKm - 2130) < 200, `共通重心までの振幅: ${maxOffsetKm} km`);
    const plutoRadiusKm = bodyDef(SOLAR_SYSTEM, 'pluto').radius / 1e3;
    assert.ok(maxOffsetKm > plutoRadiusKm, '共通重心が冥王星本体の内側に収まっている(連星になっていない)');
  });

  test('equatorial-satellites: 未測定 GM は 0、実測されているものは 0 でない', () => {
    assert.ok(muOf('charon') > 0, 'カロンの GM は実測値を持つはず');
    assert.equal(muOf('styx'), 0, 'ステュクスの GM は上限値のみ(未測定)');
    assert.equal(muOf('kerberos'), 0, 'ケルベロスの GM は上限値のみ(未測定)');
    assert.equal(muOf('puck'), 0, 'パックの GM は表に無い(未測定)');
  });

  // mu = 0 は「質量が未測定」であって質量0ではない。衛星だけが質量を持つ系で重心補正を
  // 掛けると、衛星の質量比が 1 になって主天体が距離ぶんまるごとずれる — 主天体と衛星の
  // 相対位置は正しいままなので、主天体の日心位置を直に見ないと分からない。
  test('equatorial-satellites: 主天体の質量が未測定の系では、衛星を足しても主天体が動かない', () => {
    for (const [primary, satellite] of [['quaoar', 'weywot'], ['orcus', 'vanth']] as const) {
      const withoutSatellite = { ...SOLAR_SYSTEM } as Record<string, CelestialBodyDef>;
      delete withoutSatellite[satellite];
      const bare = new Ephemeris(withoutSatellite, 'earth', EPOCH_T_OFFSET, {});
      const t = 1e6;
      const moved = len(sub(eph.stateOf(primary, t).r, bare.stateOf(primary, t).r));
      assert.ok(moved < 1, `${primary} が ${satellite} の有無で ${moved} m 動いている`);
    }
  });

  // 質量比が決まらない系にラグランジュ点を作らせない(共線点を解く反復が発散するか、
  // L1 が主天体の中心へ落ちる)。
  test('equatorial-satellites: どちらかの質量が未測定の系はラグランジュ点を持たない', () => {
    for (const id of ['quaoar', 'orcus', 'puck', 'styx', 'kerberos'] as const) {
      assert.equal(eph.hasUsableCollinearPoints(id, 10), false, `${id} の共線点`);
      assert.equal(eph.hasStableTriangularPoints(id), false, `${id} の三角点`);
    }
    // 両方の質量が判明していれば持つ。ディディモスは質量比が 1e-19 台まで小さいので、
    // 「質量が小さい」ことと「質量が未測定」ことが混ざっていないかを分ける。
    assert.equal(eph.hasUsableCollinearPoints('moon', 10), true, '地球-月の共線点');
    assert.equal(eph.hasStableTriangularPoints('moon'), true, '地球-月の三角点');
    assert.equal(eph.hasUsableCollinearPoints('didymos', 10), true, '太陽-ディディモスの共線点');
    assert.equal(eph.hasStableTriangularPoints('didymos'), true, '太陽-ディディモスの三角点');
  });
}
