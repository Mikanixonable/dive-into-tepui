// ephemeris.ts の回帰テスト: Ephemeris クラスの合成(恒星→重心→惑星/衛星、重心補正)
// が正しいこと。個々の軌道モデルの精度は kepler-orbit.test.ts / satellite-orbit.test.ts が担う。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { Ephemeris, EPOCH_T_OFFSET } from '../../src/physics/ephemeris';
import { CelestialBodyDef, MU_EARTH, R_EARTH_EQ, bodyDef } from '../../src/physics/solar-system';
import { MU_MOON, MU_SUN as MU_SUN_LOCAL, SOLAR_SYSTEM } from '../../src/physics/solar-system';
import { EPS } from '../../src/physics/ecliptic';
import { PlanetOrbit } from '../../src/physics/planet-orbit';
import { SatelliteOrbit } from '../../src/physics/satellite-orbit';
import { JULIAN_CENTURY, keplerOrbitState } from '../../src/physics/kepler-orbit';
import { qInvert, qMul, qRotate } from '../../src/physics/attitude';
import { meridianDirection } from '../../src/physics/body-orientation';
import { SIDEREAL_DAY } from '../../src/physics/solar-system';
import { cross, dot, len, norm, scale, sub, v3 } from '../../src/math/vec3';
import { toFrameState } from '../../src/physics/frame';
import { bodyAnchorSource } from '../../src/physics/celestial-body';
import { kinematicState } from '../../src/physics/kinematic-state';
import { AbsoluteEphemeris } from '../../src/physics/absolute-ephemeris';
import { assertOmegaMatchesBasis } from './test-helpers';

const YEAR = 365.25636 * 86400;
const MOON_PERIOD = 27.321661 * 86400;
const DAY = 86400;
// 地球-月重心の日心ケプラー軌道(SOLAR_SYSTEM の宣言そのもの)。重心不変条件の
// 検証で Ephemeris の合成結果と突き合わせる基準として使う。
const EARTH_ORBIT: PlanetOrbit = (SOLAR_SYSTEM.earth as { orbit: PlanetOrbit }).orbit;

// テスト対象の id が惑星/衛星であることを前提に軌道モデルを取り出す(SOLAR_SYSTEM 自身は
// 各エントリの具体型を保つが、動的な id 引数を介すと判別できなくなるため断定する)。
function planetOrbit(id: string): PlanetOrbit {
  return (bodyDef(SOLAR_SYSTEM, id) as Extract<CelestialBodyDef, { kind: 'planet' }>).orbit;
}
function satelliteOrbitOf(id: string): SatelliteOrbit {
  return (bodyDef(SOLAR_SYSTEM, id) as Extract<CelestialBodyDef, { kind: 'satellite' }>).orbit;
}

export function register(): void {
  const eph = new Ephemeris(SOLAR_SYSTEM, 'earth', EPOCH_T_OFFSET, { earth: 0.3, moon: 0.4 });

  test('ephemeris: frameOf は同じ対に同じ参照を返し、inertialFrame/frames/frameFor と一致する', () => {
    assert.equal(eph.frameOf('earth', null), eph.frameOf('earth', null));
    assert.equal(eph.frameOf('earth', { kind: 'revolution', id: 'moon' }), eph.frameOf('earth', { kind: 'revolution', id: 'moon' }));
    assert.equal(eph.frameOf('earth', null), eph.inertialFrame);
    assert.equal(eph.frameOf('earth', null), eph.frameFor('earth'));
    assert.equal(eph.frameOf('sun', null), eph.frameFor('sun'));
    for (const frame of eph.frames) {
      assert.equal(eph.frameOf(frame.center, frame.rotatingWith), frame);
    }
    assert.notEqual(eph.frameOf('earth', { kind: 'revolution', id: 'moon' }), eph.frameOf('earth', null));
    // 同じ天体でも自転と公転は別の座標系で、rotatingWith オブジェクトも呼び出しごとに同一参照。
    const spinEarth = eph.frameOf('earth', { kind: 'spin', id: 'earth' });
    const revolutionEarth = eph.frameOf('earth', { kind: 'revolution', id: 'earth' });
    assert.notEqual(spinEarth, revolutionEarth);
    assert.equal(spinEarth.rotatingWith, eph.frameOf('earth', { kind: 'spin', id: 'earth' }).rotatingWith);
  });

  test('ephemeris: 地球は ECI 原点に厳密に静止する', () => {
    for (const t of [0, 1e6, 1e8]) {
      const s = eph.stateOf('earth', t);
      assert.deepEqual(s.r, v3(0, 0, 0));
      assert.deepEqual(s.v, v3(0, 0, 0));
    }
  });

  test('ephemeris: 太陽の地心距離は地球軌道の離心率(0.0167)ぶんの範囲を振る(固定値ではない)', () => {
    let minD = Infinity;
    let maxD = 0;
    for (let i = 0; i < 32; i++) {
      const t = (i / 32) * YEAR;
      const d = len(eph.positionOf('sun', t));
      minD = Math.min(minD, d);
      maxD = Math.max(maxD, d);
    }
    assert.ok(minD > 1.47e11 && minD < 1.475e11, `近日点付近: ${minD}`);
    assert.ok(maxD > 1.515e11 && maxD < 1.525e11, `遠日点付近: ${maxD}`);
  });

  // 重心補正の直接検証: ECI での重心位置は「地球は原点」なので (μ_e·0+μ_m·r_moon)/(μ_e+μ_m)
  // に一致するはずで、これは PlanetOrbit(地球-月重心)から求めた日心重心位置を
  // 日心地球位置(= -太陽の地心位置)だけ ECI へ平行移動した値とも一致しなければならない。
  test('ephemeris: 重心の不変条件(質量加重平均 = PlanetOrbit の重心を ECI 化した値、位置・速度とも)', () => {
    for (const t of [0, 1e6, 3e8]) {
      const moonState = eph.stateOf('moon', t);
      const wMoon = MU_MOON / (MU_EARTH + MU_MOON);
      const baryFromMass = { r: scale(moonState.r, wMoon), v: scale(moonState.v, wMoon) };

      const sunEci = eph.stateOf('sun', t);
      const earthHelio = { r: scale(sunEci.r, -1), v: scale(sunEci.v, -1) }; // 太陽は日心原点
      const baryHelio = keplerOrbitState(EARTH_ORBIT, t + EPOCH_T_OFFSET, 0.3);
      const baryFromKepler = { r: sub(baryHelio.r, earthHelio.r), v: sub(baryHelio.v, earthHelio.v) };

      const rErr = len(sub(baryFromMass.r, baryFromKepler.r));
      const vErr = len(sub(baryFromMass.v, baryFromKepler.v));
      assert.ok(rErr < 1, `重心位置の不一致 (t=${t}): ${rErr} m`);
      assert.ok(vErr < 1e-6, `重心速度の不一致 (t=${t}): ${vErr} m/s`);
    }
  });

  // 地球を完全なケプラー軌道(重心補正なし)に置いた場合の太陽の地心位置との差は、
  // 地球-重心オフセット(= 重心補正そのもの)に等しく、月の公転周期で振れ、平均して
  // 4,673 km 前後になる(月の距離レンジ × 質量比 ≈ 4,331〜4,941 km)。
  test('ephemeris: 太陽の地心位置は純ケプラー地球位置から重心補正ぶん(月の位相と共に振れる約4,673km)ずれる', () => {
    const wMoon = MU_MOON / (MU_EARTH + MU_MOON);
    const diffAt = (t: number) => {
      const bary = keplerOrbitState(EARTH_ORBIT, t + EPOCH_T_OFFSET, 0.3);
      const pureKeplerSunEci = scale(bary.r, -1);
      return sub(eph.positionOf('sun', t), pureKeplerSunEci);
    };

    const d0 = diffAt(1e6);
    const mag = len(d0);
    assert.ok(mag > 4.0e6 && mag < 5.0e6, `重心補正ぶんのずれ: ${mag} m`);

    // 補正ベクトルは月方向を向く(地球は重心を挟んで月と反対側にずれるので、地球→重心は月方向)。
    const moonDir = norm(eph.stateOf('moon', 1e6).r);
    assert.ok(dot(norm(d0), moonDir) > 0.99, '補正ベクトルは月方向を向く');

    // 恒星月周期で振れる(昇交点・近点歳差は1周期では無視できるほど小さい)。
    const d1 = diffAt(1e6 + MOON_PERIOD);
    assert.ok(Math.abs(len(d0) - len(d1)) / len(d0) < 0.01, `1恒星月周期での再現性: ${len(d0)} vs ${len(d1)}`);
  });

  test('ephemeris: 太陽-地球ラグランジュ点の無次元距離比は文献値と一致する(0.00997/0.01004)', () => {
    for (const t of [0, 1e7, 1e9]) {
      const sunDist = len(eph.positionOf('sun', t));
      const { L1, L2 } = eph.lagrangeAt('earth', t);
      assert.ok(Math.abs(len(L1) / sunDist - 0.00997) < 1e-3, `L1 比: ${len(L1) / sunDist}`);
      assert.ok(Math.abs(len(L2) / sunDist - 0.01004) < 1e-3, `L2 比: ${len(L2) / sunDist}`);
    }
  });

  test('ephemeris: 地球-月ラグランジュ点は白道面内にあり、L1/L2 は文献値の距離比になる(0.15093/0.16783)', () => {
    for (const t of [0, 1e6, 1e8]) {
      const moonPos = eph.positionOf('moon', t);
      const R = len(moonPos);
      const n = eph.orbitNormalAt('moon', t);
      const { L1, L2, L4, L5 } = eph.lagrangeAt('moon', t);
      for (const [name, p] of [['L1', L1], ['L2', L2], ['L4', L4], ['L5', L5]] as const) {
        assert.ok(Math.abs(dot(p, n)) < 1e-6 * R, `${name} が白道面から外れる (t=${t})`);
      }
      // 周期摂動項ぶん実際の月位置は回転系の x̂ 軸から最大 1.4° ほどずれる
      // (satellite-orbit.ts のコメント参照)ため、文献値との一致は 3e-3 まで緩める。
      assert.ok(Math.abs(len(sub(L1, moonPos)) / R - 0.15093) < 3e-3, `L1 距離比 (t=${t})`);
      assert.ok(Math.abs(len(sub(L2, moonPos)) / R - 0.16783) < 3e-3, `L2 距離比 (t=${t})`);
    }
  });

  // 共線点の内外関係と L3/L4/L5 の幾何。x̂ を「主天体→副天体」へ統一した写像が正しいことは、
  // 距離比だけでなく「どちら側に置かれるか」で初めて確かめられる。
  test('ephemeris: 地球-月ラグランジュ点の L1/L2 は月の内外、L3 は反月方向、L4/L5 は正三角形', () => {
    for (const t of [0, 1e6, 1e8]) {
      const moonPos = eph.positionOf('moon', t);
      const R = len(moonPos);
      const mHat = norm(moonPos);
      const n = eph.orbitNormalAt('moon', t);
      const { L1, L2, L3, L4, L5 } = eph.lagrangeAt('moon', t);
      assert.ok(len(L1) < R && len(L2) > R, `L1/L2 の内外 (t=${t})`);
      // 同じ理由で厳密な反対方向(-1)からは最大 1.4° ほどずれうる。
      assert.ok(dot(norm(L3), mHat) < -0.999, `L3 が反月方向でない (t=${t})`);
      const lead = cross(n, mHat); // 公転前方
      for (const [name, p, sign] of [['L4', L4, 1], ['L5', L5, -1]] as const) {
        assert.ok(Math.abs(len(p) - R) < 1e-6 * R, `${name} の軌道半径 (t=${t}): ${len(p)}`);
        // L4/L5 は回転系(平均要素)の正三角形、moonPos は周期摂動込みの実位置なので
        // 最大 1.4° ぶんの角度ずれが距離へ乗る。
        assert.ok(Math.abs(len(sub(p, moonPos)) - R) < 3e-2 * R, `${name} と月の距離 (t=${t})`);
        assert.ok(sign * dot(norm(p), lead) > 0, `${name} の前後 (t=${t})`);
      }
    }
  });

  // 太陽-地球系では地球が副天体なので、地心を原点とする ECI での配置は地球-月系と別物になる:
  // L1/L2 は地球の両隣、L3 は太陽の向こう側(地心から約 2 au)、L4/L5 は地心から 1 au。
  test('ephemeris: 太陽-地球ラグランジュ点は黄道面内にあり、L3 は約2au 太陽側・L4/L5 は正三角形', () => {
    const mu = MU_EARTH / (MU_SUN_LOCAL + MU_EARTH);
    for (const t of [0, 1e7, 1e9]) {
      const sPos = eph.positionOf('sun', t);
      const R = len(sPos);
      const sHat = norm(sPos);
      const n = eph.orbitNormalAt('earth', t);
      const { L1, L2, L3, L4, L5 } = eph.lagrangeAt('earth', t);
      // 地心を原点に測るので、L点は地球自身の重心まわりの首振り(最大 4,673 km、うち白道の
      // 傾き 5.145° ぶんの約 420 km が黄道面外)を丸ごと引き継ぐ。許容はその桁で取る。
      for (const [name, p] of [['L1', L1], ['L2', L2], ['L3', L3], ['L4', L4], ['L5', L5]] as const) {
        assert.ok(Math.abs(dot(p, n)) < 1e-5 * R, `${name} が黄道面から外れる (t=${t})`);
      }
      // 共線点は地心距離が 1 au の約 1% しかないので、回転系の x̂ 軸と太陽の実方向の
      // ずれ(重心補正ぶんの ~3e-5 rad)がそのまま約100倍に拡大されて向きへ乗る。
      assert.ok(dot(norm(L1), sHat) > 0.99999, `L1 が太陽側でない (t=${t})`);
      assert.ok(dot(norm(L2), sHat) < -0.99999, `L2 が反太陽側でない (t=${t})`);
      // 距離の同一性も同じ首振りを受ける(L3 は 2 au 先なのでその2倍effectively)。
      // 桁(1 au に対する 2 au、正三角形の 1 au)が確かめられれば十分なので許容は 1e-4·R。
      assert.ok(Math.abs(len(L3) - R * (2 + (5 / 12) * mu)) < 1e-4 * R, `L3 の地心距離 (t=${t}): ${len(L3)}`);
      assert.ok(dot(norm(L3), sHat) > 0.9999, `L3 が太陽側でない (t=${t})`);
      for (const [name, p] of [['L4', L4], ['L5', L5]] as const) {
        assert.ok(Math.abs(len(p) - R) < 1e-4 * R, `${name} の地心距離 (t=${t}): ${len(p)}`);
        assert.ok(Math.abs(len(sub(p, sPos)) - R) < 1e-4 * R, `${name} の日心距離 (t=${t})`);
      }
      assert.ok(dot(norm(L4), cross(n, sHat)) * dot(norm(L5), cross(n, sHat)) < 0, `L4/L5 が同じ側 (t=${t})`);
    }
  });

  // 月の平均黄経は恒星月でちょうど1周し、実黄経との差は中心差(最大 ~2e = 6.3°)の振動に
  // とどまる。昇交点・近点の歳差を平均黄経に混ぜると、この差が年オーダーで単調に開く
  // (1年で -19° 級)ため、長期の時間加速で月とラグランジュ点が実位置から外れる。
  test('ephemeris: 月の黄経は恒星月の平均運動で進む(歳差ぶんの遅速がない)', () => {
    const moonEph = new Ephemeris(SOLAR_SYSTEM, 'earth', EPOCH_T_OFFSET, { moon: 0 });
    const MOON_ECC = 0.0549;
    const maxCenterDeg = (2 * MOON_ECC * 180) / Math.PI + 0.5;
    for (const days of [27.321661, 365.25, 3652.5]) {
      const t = days * 86400;
      const mean = (2 * Math.PI * (t + EPOCH_T_OFFSET)) / MOON_PERIOD;
      let lon = eclipticLongitude(moonEph.positionOf('moon', t));
      lon += 2 * Math.PI * Math.round((mean - lon) / (2 * Math.PI)); // mean に最も近い分枝へ
      const errDeg = ((lon - mean) * 180) / Math.PI;
      assert.ok(Math.abs(errDeg) < maxCenterDeg, `黄経の平均運動からのずれ (t=${days}日): ${errDeg}°`);
    }
  });

  test('ephemeris: orbitNormalAt(moon) は昇交点歳差で赤道傾斜 18.3°〜28.6° を掃く', () => {
    const NODE_PERIOD = 18.612958 * 365.25 * 86400;
    let minDeg = 180;
    let maxDeg = 0;
    for (let i = 0; i < 64; i++) {
      const n = eph.orbitNormalAt('moon', (i / 64) * NODE_PERIOD);
      const deg = (Math.acos(Math.max(-1, Math.min(1, dot(n, v3(0, 1, 0))))) * 180) / Math.PI;
      minDeg = Math.min(minDeg, deg);
      maxDeg = Math.max(maxDeg, deg);
    }
    assert.ok(Math.abs(minDeg - 18.294) < 0.2, `最小傾斜: ${minDeg}°`);
    assert.ok(Math.abs(maxDeg - 28.584) < 0.2, `最大傾斜: ${maxDeg}°`);
  });

  test('ephemeris: sunDirFrom は単位ベクトルで、基準点から太陽へ向く', () => {
    for (const t of [0, 1e6, 1e8]) {
      const dir = eph.sunDirFrom(v3(0, 0, 0), t);
      assert.ok(Math.abs(len(dir) - 1) < 1e-12, `単位ベクトルでない: ${len(dir)}`);
      const pos = eph.positionOf('sun', t);
      assert.ok(len(sub(dir, norm(pos))) < 1e-12, `原点からの方向が positionOf(sun) と一致しない`);
      // 木星から見た太陽方向は、木星→太陽のベクトルと一致する(地心方向では代用できない)。
      const jup = eph.positionOf('jupiter', t);
      assert.ok(len(sub(eph.sunDirFrom(jup, t), norm(sub(pos, jup)))) < 1e-12, '基準点が反映されていない');
    }
  });

  test('ephemeris: celestialBodiesAt は SOLAR_SYSTEM の宣言順で、地球は静止・半径は赤道半径 R_EARTH_EQ', () => {
    const celestialBodies = eph.celestialBodiesAt(1234);
    assert.deepEqual(celestialBodies.map((b) => b.id), ['earth', 'moon', 'mercury', 'venus', 'mars', 'phobos', 'deimos', 'jupiter', 'metis', 'adrastea', 'amalthea', 'thebe', 'io', 'europa', 'ganymede', 'callisto', 'himalia', 'elara', 'ananke', 'carme', 'pasiphae', 'sinope', 'saturn', 'pan', 'daphnis', 'prometheus', 'pandora', 'epimetheus', 'janus', 'mimas', 'enceladus', 'tethys', 'dione', 'rhea', 'titan', 'hyperion', 'iapetus', 'phoebe', 'uranus', 'puck', 'miranda', 'ariel', 'umbriel', 'titania', 'oberon', 'neptune', 'triton', 'nereid', 'ceres', 'vesta', 'pallas', 'pluto', 'charon', 'styx', 'nix', 'kerberos', 'hydra', 'haumea', 'hiiaka', 'namaka', 'makemake', 'eris', 'dysnomia', 'halley', 'encke', 'sedna', 'quaoar', 'weywot', 'chariklo', 'hygiea', 'eros', 'ryugu', 'bennu', 'orcus', 'vanth', 'gonggong', 'salacia', 'varuna', 'ixion', 'arrokoth', 'chiron', 'interamnia', 'europa52', 'davida', 'juno', 'psyche', 'eunomia', 'sylvia', 'apophis', 'didymos', 'tempel1', 'wild2', 'hartley2', 'cruithne', 'kamooalewa', 'tk7', 'eureka', 'sun']);
    assert.equal(celestialBodies[0]!.radius, R_EARTH_EQ);
  });

  test('ephemeris: 同一 t の celestialBodiesAt は同一配列参照を返す', () => {
    const e = new Ephemeris(SOLAR_SYSTEM, 'earth', EPOCH_T_OFFSET, { earth: 0.3, moon: 0.4 });
    assert.equal(e.celestialBodiesAt(1234), e.celestialBodiesAt(1234));
  });

  test('ephemeris: gravityAttractorsAt は mu が 0 でない天体だけを宣言順で返す', () => {
    const gravity = eph.gravityAttractorsAt(1234);
    assert.ok(gravity.every((b) => b.mu !== 0));
    const expected = eph.celestialBodiesAt(1234).filter((b) => b.mu !== 0).map((b) => b.id);
    assert.deepEqual(gravity.map((b) => b.id), expected);
    assert.ok(gravity.length > 0 && gravity.length < eph.celestialBodiesAt(1234).length);
  });

  test('ephemeris: gravityAttractorsAt の要素は同一 t の celestialBodiesAt と厳密に一致する', () => {
    const t = 4321;
    const all = new Map(eph.celestialBodiesAt(t).map((b) => [b.id, b]));
    for (const g of eph.gravityAttractorsAt(t)) {
      const a = all.get(g.id)!;
      assert.deepEqual(g.state.r, a.state.r);
      assert.deepEqual(g.state.v, a.state.v);
      assert.equal(g.state.t, a.state.t);
      assert.equal(g.mu, a.mu);
      assert.equal(g.radius, a.radius);
    }
  });

  test('ephemeris: 同一 t の gravityAttractorsAt は同一配列参照を返す', () => {
    const e = new Ephemeris(SOLAR_SYSTEM, 'earth', EPOCH_T_OFFSET, { earth: 0.3, moon: 0.4 });
    assert.equal(e.gravityAttractorsAt(1234), e.gravityAttractorsAt(1234));
    assert.notEqual(e.gravityAttractorsAt(1234), e.celestialBodiesAt(1234));
  });

  test('ephemeris: 異なる t では再計算され、値が変わる', () => {
    const e = new Ephemeris(SOLAR_SYSTEM, 'earth', EPOCH_T_OFFSET, { earth: 0.3, moon: 0.4 });
    const a = e.celestialBodiesAt(0);
    const b = e.celestialBodiesAt(1e5);
    assert.notEqual(a, b);
    const moonA = a.find((x) => x.id === 'moon')!.state.r;
    const moonB = b.find((x) => x.id === 'moon')!.state.r;
    assert.ok(len(sub(moonA, moonB)) > 1e6, `月が動いていない: ${len(sub(moonA, moonB))}`);
    // 直近 t を巡回で保持するので、古い t を引き直しても同じ値が返る。
    assert.deepEqual(e.celestialBodiesAt(0), a);
  });

  test('ephemeris: 位相オフセットが違えば同じ時刻でも別の位置になる', () => {
    const a = new Ephemeris(SOLAR_SYSTEM, 'earth', EPOCH_T_OFFSET, { earth: 0.3, moon: 0.4 });
    const b = new Ephemeris(SOLAR_SYSTEM, 'earth', EPOCH_T_OFFSET, { earth: 0.3, moon: 2.1 });
    const moonA = a.celestialBodiesAt(1234).find((x) => x.id === 'moon')!.state.r;
    const moonB = b.celestialBodiesAt(1234).find((x) => x.id === 'moon')!.state.r;
    assert.ok(len(sub(moonA, moonB)) > 1e6, `位相オフセットが反映されていない: ${len(sub(moonA, moonB))}`);
    // celestialBodiesAt の時刻キャッシュを経由しても positionOf と同じ値を返す。
    assert.deepEqual(moonB, b.positionOf('moon', 1234));
  });

  // EPOCH_T_OFFSET はこの見た目の条件そのものから逆算された定数なので、これはその逆算の検算。
  // 平均黄経で合わせているぶん、中心差(地球の e=0.0167 で最大 1.9°)だけ真の方向はずれる。
  test('ephemeris: t=0 では太陽が +X 方向(昼側)にある', () => {
    const dir = new Ephemeris(SOLAR_SYSTEM, 'earth', EPOCH_T_OFFSET, {}).sunDirFrom(v3(0, 0, 0), 0);
    const offDeg = (Math.acos(dir.x / len(dir)) * 180) / Math.PI;
    assert.ok(offDeg < 3, `t=0 の太陽方向が +X から離れている: ${offDeg}°`);
  });

  // 要素の元期は全天体で J2000 に揃っているので、評価時刻を EPOCH_T_OFFSET だけ戻した瞬間の
  // 日心黄経差は Standish 表の L(平均黄経)の差になる。実位置の黄経は真黄経なので、両天体の
  // 中心差(最大 2e: 地球 1.9°・木星 5.6°)ぶんまで離れうる — 元期不整合(78° 級)を捕まえる
  // にはこの幅で足りる。
  test('ephemeris: 地球と木星の日心黄経差は t=−EPOCH_T_OFFSET で J2000 の表の値と一致する', () => {
    const e = new Ephemeris(SOLAR_SYSTEM, 'earth', EPOCH_T_OFFSET, {});
    const t = -EPOCH_T_OFFSET;
    const sun = e.positionOf('sun', t);
    const earthHelio = scale(sun, -1);
    const jupiterHelio = sub(e.positionOf('jupiter', t), sun);
    const diffDeg = ((eclipticLongitude(jupiterHelio) - eclipticLongitude(earthHelio)) * 180) / Math.PI;
    const expectedDeg = 34.39644051 - 100.46457166;
    const errDeg = ((diffDeg - expectedDeg + 540) % 360) - 180;
    assert.ok(Math.abs(errDeg) < 8, `J2000 の黄経差からのずれ: ${errDeg}°`);
  });

  // 平均黄経の変化率から出る公転周期が、長半径とケプラー第3法則から出る周期と一致すること。
  // 表の a と L̇ が別々の列である以上、両者の整合は転記ミスを直接捕まえる検査になる。
  test('ephemeris: 各惑星の公転周期はケプラー第3法則と 0.1% 以内で一致する', () => {
    for (const id of ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'] as const) {
      const orbit = planetOrbit(id);
      const fromRate = (2 * Math.PI) / orbit.lRate;
      const fromKepler = 2 * Math.PI * Math.sqrt(orbit.a ** 3 / MU_SUN_LOCAL);
      assert.ok(Math.abs(fromRate / fromKepler - 1) < 1e-3, `${id} の周期: ${fromRate} vs ${fromKepler}`);
    }
  });

  test('ephemeris: 各惑星の近日点距離 a(1−e) が表の値になる', () => {
    const AU = 1.495978707e11;
    const expected: Record<string, number> = {
      mercury: 0.3075, venus: 0.7184, mars: 1.3814, jupiter: 4.9511,
      saturn: 9.0229, uranus: 18.2825, neptune: 29.8115,
    };
    for (const [id, auValue] of Object.entries(expected)) {
      const orbit = planetOrbit(id);
      const perihelionAu = (orbit.a * (1 - orbit.e)) / AU;
      assert.ok(Math.abs(perihelionAu - auValue) < 1e-3, `${id} の近日点距離: ${perihelionAu} au`);
    }
  });

  // Standish 表は PPN 相対論込みで数値積分された JPL DE 暦へのフィットなので、水星の近日点移動
  // には一般相対論ぶんの 42.98″/Cy が既に含まれる(惑星摂動のみの古典値は約 531.6″/Cy)。
  test('ephemeris: 水星の近日点移動は一般相対論込みの 574〜578″/Cy に入る', () => {
    const rateArcsecPerCentury = ((planetOrbit('mercury').lonPeriRate * JULIAN_CENTURY * 180) / Math.PI) * 3600;
    assert.ok(rateArcsecPerCentury > 574 && rateArcsecPerCentury < 578, `水星 ϖ̇: ${rateArcsecPerCentury}″/Cy`);
  });

  // 平均運動は長半径と親の重力定数からケプラー第3法則で導くので、周期の一致は
  // 登録した a と親の μ が実測どおりに噛み合っていることの検算になる。
  test('ephemeris: 主要衛星の公転周期が実測値と一致する', () => {
    const cases: readonly [string, number][] = [
      ['io', 1.769138 * 86400],
      ['europa', 3.551181 * 86400],
      ['ganymede', 7.154553 * 86400],
      ['callisto', 16.689017 * 86400],
      ['titan', 15.945 * 86400],
      ['triton', 5.876854 * 86400],
      ['phobos', 7.6533 * 3600],
      ['deimos', 30.312 * 3600],
    ];
    for (const [id, expected] of cases) {
      const period = (2 * Math.PI) / satelliteOrbitOf(id).kepler.lRate;
      assert.ok(Math.abs(period / expected - 1) < 0.01, `${id} の公転周期: ${period / 86400} 日(期待 ${expected / 86400} 日)`);
    }
  });

  // 親惑星の赤道面を基準面として登録できていれば、軌道法線は親の自転軸のすぐ近くに来る。
  // 黄道基準のままだと木星の赤道傾斜 3.13° と黄道傾斜 23.44° ぶん離れる。
  test('ephemeris: ガリレオ衛星の軌道面は木星の赤道面に一致する', () => {
    const pole = eph.poleAt('jupiter', 1e7)!.axis;
    for (const id of ['io', 'europa', 'ganymede', 'callisto'] as const) {
      const offDeg = (Math.acos(dot(eph.orbitNormalAt(id, 1e7), pole)) * 180) / Math.PI;
      assert.ok(offDeg < 1, `${id} の軌道面法線と木星自転軸のなす角: ${offDeg}°`);
    }
  });

  test('ephemeris: トリトンは海王星の自転に対して逆行する', () => {
    const t = 1e7;
    const rel = sub(eph.stateOf('triton', t).r, eph.stateOf('neptune', t).r);
    const relVel = sub(eph.stateOf('triton', t).v, eph.stateOf('neptune', t).v);
    const h = cross(rel, relVel);
    assert.ok(dot(h, eph.poleAt('neptune', t)!.axis) < 0, `トリトンの軌道角運動量が順行している: ${dot(norm(h), eph.poleAt('neptune', t)!.axis)}`);
  });

  // 準惑星・大型小惑星・彗星核の登録が実測の公転周期・近日点距離と噛み合っていることの検算。
  test('ephemeris: 準惑星・彗星核の公転周期が実測値の範囲に入る', () => {
    const cases: readonly [string, number][] = [
      ['pluto', 248 * YEAR],
      ['halley', 75.5 * YEAR], // 実測は約75.3〜76.0年で幅がある
      ['ceres', 4.6 * YEAR],
    ];
    for (const [id, expected] of cases) {
      const period = (2 * Math.PI) / planetOrbit(id).lRate;
      assert.ok(Math.abs(period / expected - 1) < 0.02, `${id} の公転周期: ${period / YEAR} 年(期待 ${expected / YEAR} 年)`);
    }
  });

  test('ephemeris: ハレー彗星の近日点距離は約0.586auになる', () => {
    const AU = 1.495978707e11;
    const orbit = planetOrbit('halley');
    const q = orbit.a * (1 - orbit.e);
    assert.ok(Math.abs(q / (0.586 * AU) - 1) < 0.02, `ハレー彗星の近日点距離: ${q / AU} au`);
  });

  // 冥王星の近日点は海王星の軌道半径より内側 — 実際の軌道交差を表現できていることの確認。
  test('ephemeris: 冥王星の近日点距離は海王星の半長径より小さい(軌道交差)', () => {
    const plutoOrbit = planetOrbit('pluto');
    const q = plutoOrbit.a * (1 - plutoOrbit.e);
    assert.ok(q < planetOrbit('neptune').a, `冥王星近日点: ${q}, 海王星半長径: ${planetOrbit('neptune').a}`);
  });

  test('ephemeris: spinRotationAt(earth) の姿勢は1恒星日でほぼ元へ戻る', () => {
    const q0 = eph.spinRotationAt('earth', 0)!.q;
    const q1 = eph.spinRotationAt('earth', SIDEREAL_DAY)!.q;
    // q1 * inverse(q0) の回転角(2倍角の余弦を w から取り出す)が 2π の整数倍に近いかを見る。
    const rel = qMul(q1, qInvert(q0));
    const angle = 2 * Math.acos(Math.min(1, Math.abs(rel.w)));
    assert.ok(angle < 1e-6, `1恒星日後の残差角: ${angle}`);
  });

  test('ephemeris: spinRotationAt(earth) の姿勢は自転中も omega と整合する', () => {
    const t = SIDEREAL_DAY / 3;
    const q0 = eph.spinRotationAt('earth', 0)!.q;
    const qt = eph.spinRotationAt('earth', t)!.q;
    const rel = qMul(qt, qInvert(q0));
    const angle = 2 * Math.acos(Math.min(1, Math.abs(rel.w)));
    assert.ok(Math.abs(angle - (2 * Math.PI) / 3) < 1e-6, `経過角: ${angle}`);
    assertOmegaMatchesBasis((time) => eph.spinRotationAt('earth', time)!, t, 1);
  });

  test('ephemeris: spinRotationAt(earth) の姿勢は時刻とともに自転角だけ進む', () => {
    const q0 = eph.spinRotationAt('earth', 0)!.q;
    const quarter = eph.spinRotationAt('earth', SIDEREAL_DAY / 4)!.q;
    const rel = qMul(quarter, qInvert(q0));
    const angle = 2 * Math.acos(Math.min(1, Math.abs(rel.w)));
    assert.ok(Math.abs(angle - Math.PI / 2) < 1e-9, `1/4恒星日後の姿勢差: ${angle}`);
  });

  test('ephemeris: spinRotationAt(earth) の omega の大きさは 2π/恒星日 に一致する', () => {
    const { omega } = eph.spinRotationAt('earth', 12345)!;
    const expected = (2 * Math.PI) / SIDEREAL_DAY;
    assert.ok(Math.abs(len(omega) - expected) / expected < 1e-6, `|omega|: ${len(omega)} vs ${expected}`);
  });

  test('ephemeris: spinRotationAt は自転モデルを持たない天体(ceres)で null', () => {
    assert.equal(eph.spinRotationAt('ceres', 0), null);
  });

  // 公転回転系(orbitFrameRotationAt)が ẑ に軌道面法線・x̂ に中心天体→天体を置くのに合わせ、
  // 自転回転系は ẑ に自転軸・x̂ に本初子午線を置く。ここが崩れると、自転系だけ軸の意味が
  // 変わってしまい、同じパネルで選んだ2つの座標系が別の規約で回る。
  test('ephemeris: spinRotationAt の基底は ẑ = 自転軸、x̂ = 本初子午線', () => {
    const t = 98765;
    const { axis, spinAngle } = eph.poleAt('earth', t)!;
    const { q } = eph.spinRotationAt('earth', t)!;
    const zHat = qRotate(q, v3(0, 0, 1));
    const xHat = qRotate(q, v3(1, 0, 0));
    const meridian = meridianDirection(axis, spinAngle);
    assert.ok(len(sub(zHat, axis)) < 1e-9, `ẑ: ${JSON.stringify(zHat)} vs ${JSON.stringify(axis)}`);
    assert.ok(len(sub(xHat, meridian)) < 1e-9, `x̂: ${JSON.stringify(xHat)} vs ${JSON.stringify(meridian)}`);
  });

  // 自転回転系の存在意義そのもの。omega を 0 のまま置くと位置だけは正しく変換されるので
  // 軌道線では気付けず、速度を通す量(座標系相対速度・計画バーンの Δv)だけが静かにずれる。
  test('ephemeris: 自転回転系では地表に固定した点の座標系相対速度が 0 になる', () => {
    const t = 55555;
    const tf = eph.frameTransformAt(eph.frameOf('earth', { kind: 'spin', id: 'earth' }), t, bodyAnchorSource([]));
    // 座標系相対で (R, 0, 0) に置いた点を ECI へ戻し、自転とともに動く速度を与える。
    const r = qRotate(tf.q, v3(R_EARTH_EQ, 0, 0));
    const rel = toFrameState(tf, kinematicState(t, r, cross(tf.omega, r)));
    assert.ok(len(rel.v) < 1e-6, `|v_rel|: ${len(rel.v)} m/s`);
    assert.ok(len(sub(rel.r, v3(R_EARTH_EQ, 0, 0))) < 1e-6, `r_rel: ${JSON.stringify(rel.r)}`);
  });

  // 逆行自転は軸を反転せずに角速度の符号で表す — 金星の omega は IAU の北極と逆を向く。
  test('ephemeris: 逆行自転(金星)の omega は自転軸と逆向き', () => {
    const t = 4242;
    const { axis } = eph.poleAt('venus', t)!;
    const { omega } = eph.spinRotationAt('venus', t)!;
    assert.ok(dot(omega, axis) < 0, `dot: ${dot(omega, axis)}`);
  });

  // 高精度暦パックの有効期間(CELESTIAL.md 2.2)を10日間だけに絞ったモックで、期間内/外の
  // 境界をまたいで stateOf/orbitFrameRotationAt/orbitNormalAt を呼ぶ。
  const preciseEpochJdTdb = 2451545;
  const preciseValidDays = 10;
  const mockPrecise: AbsoluteEphemeris = {
    validStartJdTdb: preciseEpochJdTdb,
    validEndJdTdb: preciseEpochJdTdb + preciseValidDays,
    hasBody: (id) => id === 'earth' || id === 'moon',
    barycentricStateOf: (id) => ({
      r: id === 'earth' ? v3(0, 0, 0) : v3(4e8, 0, 0),
      v: id === 'earth' ? v3(0, 0, 0) : v3(0, 1e3, 0),
    }),
  };
  const analyticOnly = new Ephemeris(SOLAR_SYSTEM, 'earth', EPOCH_T_OFFSET, {});
  const withPrecise = new Ephemeris(
    SOLAR_SYSTEM, 'earth', EPOCH_T_OFFSET, {}, mockPrecise, preciseEpochJdTdb,
  );
  const tOutsideValidity = (preciseValidDays + 5) * DAY;

  test('ephemeris: 高精度暦パックの有効期間内では pack 由来の値を返す', () => {
    const s = withPrecise.stateOf('moon', 0);
    assert.ok(len(s.r) > 0 && Number.isFinite(len(s.r)));
    assert.notEqual(s.r.x, analyticOnly.stateOf('moon', 0).r.x);
  });

  test('ephemeris: 有効期間を過ぎると例外を投げずに解析暦へフォールバックする', () => {
    assert.doesNotThrow(() => withPrecise.stateOf('moon', tOutsideValidity));
    assert.doesNotThrow(() => withPrecise.orbitFrameRotationAt('moon', tOutsideValidity));
    assert.doesNotThrow(() => withPrecise.orbitNormalAt('moon', tOutsideValidity));
    const fallback = withPrecise.stateOf('moon', tOutsideValidity);
    const analytic = analyticOnly.stateOf('moon', tOutsideValidity);
    assert.ok(len(sub(fallback.r, analytic.r)) < 1e-3, `期間外は解析暦と一致するはず: ${JSON.stringify(fallback.r)} vs ${JSON.stringify(analytic.r)}`);
  });
}

// ECI(Y=北極)の位置から黄経を取り出す。標準赤道座標へ戻し、黄道傾斜ぶん回してから
// 黄道面内の偏角を測る。
function eclipticLongitude(p: { x: number; y: number; z: number }): number {
  const xs = p.x;
  const ys = -p.z;
  const zs = p.y;
  return Math.atan2(ys * Math.cos(EPS) + zs * Math.sin(EPS), xs);
}
