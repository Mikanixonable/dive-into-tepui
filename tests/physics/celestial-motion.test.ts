// celestial-motion.ts の回帰テスト: 天体1体の運動の合成(恒星→重心→惑星/衛星、重心補正)、
// 公転回転基準系から導くラグランジュ点、自転姿勢、数値暦の有効期間の扱いが正しいこと。
// 個々の軌道モデルの精度は kepler-orbit.test.ts / satellite-orbit.test.ts が担う。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { PlanetDef, PlanetMotion, SatelliteDef } from '../../src/physics/celestial-motion';
import { EARTH } from '../../src/game/celestial/solar-system/earth-system';
import {
  MU_EARTH, MU_MOON, MU_SUN as MU_SUN_LOCAL, SIDEREAL_DAY,
} from '../../src/game/celestial/solar-system/constants';
import { EPS } from '../../src/physics/ecliptic';
import { SatelliteOrbit } from '../../src/physics/satellite-orbit';
import {
  JULIAN_CENTURY, KeplerOrbit, keplerOrbitForSimZero, keplerOrbitNormal, keplerOrbitState,
} from '../../src/physics/kepler-orbit';
import { qInvert, qMul, qRotate } from '../../src/math/quat';
import { meridianDirection } from '../../src/physics/body-orientation';
import { Vec3, addScaled, cross, dot, len, norm, scale, sub, v3 } from '../../src/math/vec3';
import { icrfToGameEci } from '../../src/physics/icrf';
import { EphemerisPoints } from '../../src/physics/ephemeris/point';
import {
  assertOmegaMatchesBasis, lagrangeOf, motionOf, orbitingMotionOf, positionOf, solarSystemParts, stateOf,
  SolarSystemParts, testEphemerisPoints, TEST_EPOCH, TEST_SIM_ZERO_ET,
} from './test-helpers';

// 定義だけを引くための太陽系(id から静的事実を取り出す口としてだけ使う)。
const DEFS = solarSystemParts();

const YEAR = 365.25636 * 86400;
const MOON_PERIOD = 27.321661 * 86400;
const DAY = 86400;
// 地球-月重心の日心ケプラー軌道(地球の宣言そのもの)。重心不変条件の検証で、
// 運動の合成結果と突き合わせる基準として使う。
const EARTH_ORBIT: KeplerOrbit = EARTH.orbit;

// 重心不変条件を測る時刻。永年変化と周期項の両方が効く幅を取る。
const BARYCENTER_TIMES = [0, 1e6, 3e8, -3e8, 1e9];

// テスト対象の id が惑星/衛星であることを前提に軌道モデルを取り出す。
function planetOrbit(id: string): KeplerOrbit {
  return (motionOf(DEFS, id).def as PlanetDef).orbit;
}

// 惑星 id の運動。恒星や衛星の id を渡すと例外。系(PlanetSystem)を引くのに要る。
function planetMotionOf(parts: SolarSystemParts, id: string): PlanetMotion {
  const motion = motionOf(parts, id);
  if (!(motion instanceof PlanetMotion)) throw new Error(`惑星ではない天体 id: ${id}`);
  return motion;
}

// 衛星を持つ惑星系を、その本体の運動で代表して集める。重心不変条件は系ごとに閉じている。
function systemsWithSatellites(parts: SolarSystemParts): readonly PlanetMotion[] {
  return parts.bodies.filter(
    (m): m is PlanetMotion => m instanceof PlanetMotion && m.system.satellites.length > 0,
  );
}
function satelliteOrbitOf(id: string): SatelliteOrbit {
  return (motionOf(DEFS, id).def as SatelliteDef).orbit;
}

export function register(): void {
  const parts = solarSystemParts({ earth: 0.3, moon: 0.4 });

  test('celestial-motion: 地球は ECI 原点に厳密に静止する', () => {
    for (const t of [0, 1e6, 1e8]) {
      const s = stateOf(parts, 'earth', t);
      assert.deepEqual(s.r, v3(0, 0, 0));
      assert.deepEqual(s.v, v3(0, 0, 0));
    }
  });

  test('celestial-motion: 太陽の地心距離は地球軌道の離心率(0.0167)ぶんの範囲を振る(固定値ではない)', () => {
    let minD = Infinity;
    let maxD = 0;
    for (let i = 0; i < 32; i++) {
      const t = (i / 32) * YEAR;
      const d = len(stateOf(parts, 'sun', t).r);
      minD = Math.min(minD, d);
      maxD = Math.max(maxD, d);
    }
    assert.ok(minD > 1.47e11 && minD < 1.475e11, `近日点付近: ${minD}`);
    assert.ok(maxD > 1.515e11 && maxD < 1.525e11, `遠日点付近: ${maxD}`);
  });

  // 重心補正の直接検証: ECI での重心位置は「地球は原点」なので (μ_e·0+μ_m·r_moon)/(μ_e+μ_m)
  // に一致するはずで、これは 惑星の軌道要素(地球-月重心)から求めた日心重心位置を
  // 日心地球位置(= -太陽の地心位置)だけ ECI へ平行移動した値とも一致しなければならない。
  test('celestial-motion: 重心の不変条件(質量加重平均 = 惑星の軌道要素の重心を ECI 化した値、位置・速度とも)', () => {
    for (const t of [0, 1e6, 3e8]) {
      const moonState = stateOf(parts, 'moon', t);
      const wMoon = MU_MOON / (MU_EARTH + MU_MOON);
      const baryFromMass = { r: scale(moonState.r, wMoon), v: scale(moonState.v, wMoon) };

      const sunEci = stateOf(parts, 'sun', t);
      const earthHelio = { r: scale(sunEci.r, -1), v: scale(sunEci.v, -1) }; // 太陽は日心原点
      const baryHelio = keplerOrbitState(keplerOrbitForSimZero(EARTH_ORBIT, 0.3, TEST_SIM_ZERO_ET), t);
      const baryFromKepler = { r: sub(baryHelio.r, earthHelio.r), v: sub(baryHelio.v, earthHelio.v) };

      const rErr = len(sub(baryFromMass.r, baryFromKepler.r));
      const vErr = len(sub(baryFromMass.v, baryFromKepler.v));
      assert.ok(rErr < 1, `重心位置の不一致 (t=${t}): ${rErr} m`);
      assert.ok(vErr < 1e-6, `重心速度の不一致 (t=${t}): ${vErr} m/s`);
    }
  });

  // 上のテストは衛星が1体の系しか見ないので、Σ の重み μ_k/μ_sys を μ_k/(μ_p+μ_k) と
  // 取り違えても値が一致してしまう。**系重心は対ごとではなく全員で1点**なので、衛星を複数
  // 持つ系まで含めて押さえる。許容は f64 の丸め(実測の最大はエリスの 2.0e-3 m)に対して5倍。
  test('celestial-motion: 系の重心不変条件(衛星を複数持つ系でも Σμ_i·R_i = μ_sys·R_b)', () => {
    for (const planet of systemsWithSatellites(parts)) {
      const moons = planet.system.satellites;
      let muSys = planet.def.mu;
      for (const moon of moons) muSys += moon.def.mu;
      for (const t of BARYCENTER_TIMES) {
        const body = planet.analyticStateAt(t);
        let r: Vec3 = scale(body.r, planet.def.mu / muSys);
        let v: Vec3 = scale(body.v, planet.def.mu / muSys);
        for (const moon of moons) {
          const moonState = moon.analyticStateAt(t);
          r = addScaled(r, moonState.r, moon.def.mu / muSys);
          v = addScaled(v, moonState.v, moon.def.mu / muSys);
        }
        const bary = planet.system.analyticStateAt(t);
        assert.ok(len(sub(r, bary.r)) < 1e-2, `${planet.id} の重心位置 (t=${t}): ${len(sub(r, bary.r))} m`);
        assert.ok(len(sub(v, bary.v)) < 1e-9, `${planet.id} の重心速度 (t=${t}): ${len(sub(v, bary.v))} m/s`);
      }
    }
  });

  // 恒星の重心相対位置は各系の主星相対二体解を −Σ(μ_sys/μ_total) で畳んだものなので、
  // 畳み込みの重みが崩れると太陽系重心が原点から外れる形で出る。
  test('celestial-motion: 恒星まわりの重心不変条件(μ_s·R_s + Σ μ_sys·R_b = 0)', () => {
    const star = motionOf(parts, 'sun');
    const systems = [...new Set(parts.bodies
      .filter((m): m is PlanetMotion => m instanceof PlanetMotion)
      .map((m) => m.system))];
    let muTotal = star.def.mu;
    for (const system of systems) muTotal += system.mu;
    for (const t of BARYCENTER_TIMES) {
      let r: Vec3 = scale(star.analyticStateAt(t).r, star.def.mu / muTotal);
      for (const system of systems) {
        r = addScaled(r, system.analyticStateAt(t).r, system.mu / muTotal);
      }
      assert.ok(len(r) < 1e-5, `太陽系重心が原点から外れる (t=${t}): ${len(r)} m`);
    }
  });

  // 衛星の軌道要素は**惑星本体中心の相対軌道**であって系重心相対ではない。月の a = 384,400 km は
  // 地心距離で、重心相対の長半径 379,730 km ではない(比は 1+μ_m/μ_e = 1.0123、差 4,700 km)。
  // 取り違えると実測レンジから 1.2% 外れる。出典は satellite-orbit.ts のコメントと同じ
  // 近地点 356,400 km・遠地点 406,700 km で、モデルの切り詰めぶんを見て 0.5% まで許す。
  test('celestial-motion: 月の地心距離は相対軌道の実測レンジに収まる(系重心相対と取り違えていない)', () => {
    const moon = motionOf(parts, 'moon');
    const earth = motionOf(parts, 'earth');
    let minDist = Infinity;
    let maxDist = 0;
    // 遠地点は出差(周期 206 日)で振れるので、それを覆う 1,000 日ぶんを 12 時間刻みで見る。
    for (let t = 0; t < 1000 * 86400; t += 12 * 3600) {
      const d = len(sub(moon.analyticStateAt(t).r, earth.analyticStateAt(t).r));
      minDist = Math.min(minDist, d);
      maxDist = Math.max(maxDist, d);
    }
    assert.ok(Math.abs(minDist / 356.4e6 - 1) < 5e-3, `近地点: ${minDist} m`);
    assert.ok(Math.abs(maxDist / 406.7e6 - 1) < 5e-3, `遠地点: ${maxDist} m`);
  });

  // 暦は id ごとに天体本体か惑星系の重心かを収録している(manifest の bodyPoints)。
  // **収録した点が系の重心なら、その系列が着地するのは重心であって惑星本体ではない** —
  // 本体として扱うと系がまるごとずれる(木星系で 68 km、冥王星系で 2,128 km)。
  // 収録値そのものと突き合わせるのは、着地点を取り違えても不変条件だけなら両辺が一緒に
  // ずれて通ってしまうため。
  const JUPITER_BARY_ICRF = (t: number): Vec3 => v3(-7.8e11, 2e9 * (t / DAY), 4e10);
  const baryPackSource = testEphemerisPoints(
    -500 * DAY, 500 * DAY,
    {
      sun: (t) => ({ r: v3(1e6 * (t / DAY), 2e6, -3e6), v: v3(1e6 / DAY, 0, 0) }),
      earth: (t) => ({ r: v3(1.5e11, 3e8 * (t / DAY), -3e6), v: v3(0, 3e8 / DAY, 0) }),
      jupiter: (t) => ({ r: JUPITER_BARY_ICRF(t), v: v3(0, 2e9 / DAY, 0) }),
    },
    { jupiter: 'systemBarycenter' },
  );
  const baryPackParts = solarSystemParts({}, TEST_EPOCH, baryPackSource);

  test('celestial-motion: 系の重心を収録した数値暦の系列は、惑星本体ではなく系の重心に着地する', () => {
    const jupiter = planetMotionOf(baryPackParts, 'jupiter');
    for (const t of [0, 1e6, -1e6]) {
      const bary = jupiter.system.ownNumericStateAt(t);
      const body = jupiter.numericStateAt(t);
      assert.ok(bary !== null && body !== null, `数値暦経路が引けない (t=${t})`);
      assert.ok(len(sub(bary.r, icrfToGameEci(JUPITER_BARY_ICRF(t)))) < 1e-6,
        `系の重心が収録値と一致しない (t=${t}): ${len(sub(bary.r, icrfToGameEci(JUPITER_BARY_ICRF(t))))} m`);
      // 本体は重心から重心オフセットぶん離れる。解析経路のオフセットと一致しなければならない。
      const offset = sub(jupiter.analyticStateAt(t).r, jupiter.system.analyticStateAt(t).r);
      assert.ok(len(offset) > 1e4, `木星系の重心オフセットが小さすぎる (t=${t}): ${len(offset)} m`);
      assert.ok(len(sub(sub(body.r, bary.r), offset)) < 1e-2, `本体の置き場が重心オフセットと合わない (t=${t})`);
    }
  });

  // 着地点が正しくても合成を誤れば系の内訳が崩れるので、解析経路と同じ不変条件をパック経路でも測る。
  test('celestial-motion: 系の重心を収録した数値暦経路でも系の重心不変条件が成り立つ', () => {
    const jupiter = planetMotionOf(baryPackParts, 'jupiter');
    const moons = jupiter.system.satellites;
    let muSys = jupiter.def.mu;
    for (const moon of moons) muSys += moon.def.mu;

    for (const t of [0, 1e6, -1e6]) {
      const body = jupiter.numericStateAt(t);
      const bary = jupiter.system.ownNumericStateAt(t);
      assert.ok(body !== null && bary !== null, `数値暦経路が引けない (t=${t})`);
      let r: Vec3 = scale(body.r, jupiter.def.mu / muSys);
      for (const moon of moons) {
        const moonState = moon.numericStateAt(t);
        assert.ok(moonState !== null, `${moon.id} の数値暦経路が引けない (t=${t})`);
        r = addScaled(r, moonState.r, moon.def.mu / muSys);
      }
      assert.ok(len(sub(r, bary.r)) < 1e-2, `木星系の重心位置 (t=${t}): ${len(sub(r, bary.r))} m`);
    }
  });

  // 地球を完全なケプラー軌道(重心補正なし)に置いた場合の太陽の地心位置との差は、
  // 地球-重心オフセット(= 重心補正そのもの)に等しく、月の公転周期で振れ、平均して
  // 4,673 km 前後になる(月の距離レンジ × 質量比 ≈ 4,331〜4,941 km)。
  test('celestial-motion: 太陽の地心位置は純ケプラー地球位置から重心補正ぶん(月の位相と共に振れる約4,673km)ずれる', () => {
    const diffAt = (t: number) => {
      const bary = keplerOrbitState(keplerOrbitForSimZero(EARTH_ORBIT, 0.3, TEST_SIM_ZERO_ET), t);
      const pureKeplerSunEci = scale(bary.r, -1);
      return sub(stateOf(parts, 'sun', t).r, pureKeplerSunEci);
    };

    const d0 = diffAt(1e6);
    const mag = len(d0);
    assert.ok(mag > 4.0e6 && mag < 5.0e6, `重心補正ぶんのずれ: ${mag} m`);

    // 補正ベクトルは月方向を向く(地球は重心を挟んで月と反対側にずれるので、地球→重心は月方向)。
    const moonDir = norm(stateOf(parts, 'moon', 1e6).r);
    assert.ok(dot(norm(d0), moonDir) > 0.99, '補正ベクトルは月方向を向く');

    // 恒星月周期で振れる(昇交点・近点歳差は1周期では無視できるほど小さい)。
    const d1 = diffAt(1e6 + MOON_PERIOD);
    assert.ok(Math.abs(len(d0) - len(d1)) / len(d0) < 0.01, `1恒星月周期での再現性: ${len(d0)} vs ${len(d1)}`);
  });

  test('celestial-motion: 太陽-地球ラグランジュ点の無次元距離比は文献値と一致する(0.00997/0.01004)', () => {
    for (const t of [0, 1e7, 1e9]) {
      const sunDist = len(stateOf(parts, 'sun', t).r);
      const { L1, L2 } = lagrangeOf(parts, 'earth', t);
      assert.ok(Math.abs(len(L1) / sunDist - 0.00997) < 1e-3, `L1 比: ${len(L1) / sunDist}`);
      assert.ok(Math.abs(len(L2) / sunDist - 0.01004) < 1e-3, `L2 比: ${len(L2) / sunDist}`);
    }
  });

  test('celestial-motion: 地球-月ラグランジュ点は白道面内にあり、L1/L2 は文献値の距離比になる(0.15093/0.16783)', () => {
    const moon = orbitingMotionOf(parts, 'moon');
    for (const t of [0, 1e6, 1e8]) {
      const moonPos = stateOf(parts, 'moon', t).r;
      const R = len(moonPos);
      const n = moon.orbitNormalAt(t);
      const { L1, L2, L4, L5 } = lagrangeOf(parts, 'moon', t);
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
  test('celestial-motion: 地球-月ラグランジュ点の L1/L2 は月の内外、L3 は反月方向、L4/L5 は正三角形', () => {
    const moon = orbitingMotionOf(parts, 'moon');
    for (const t of [0, 1e6, 1e8]) {
      const moonPos = stateOf(parts, 'moon', t).r;
      const R = len(moonPos);
      const mHat = norm(moonPos);
      const n = moon.orbitNormalAt(t);
      const { L1, L2, L3, L4, L5 } = lagrangeOf(parts, 'moon', t);
      assert.ok(len(L1) < R && len(L2) > R, `L1/L2 の内外 (t=${t})`);
      // 回転基準系は月の実位置から組むので、L3 は実位置の厳密な反対方向に来る
      // (平均要素で組んでいた頃は最大 1.4° ずれていた)。
      assert.ok(dot(norm(L3), mHat) < -0.9999999999, `L3 が反月方向でない (t=${t}): ${dot(norm(L3), mHat)}`);
      const lead = cross(n, mHat); // 公転前方
      for (const [name, p, sign] of [['L4', L4, 1], ['L5', L5, -1]] as const) {
        assert.ok(Math.abs(len(p) - R) < 1e-6 * R, `${name} の軌道半径 (t=${t}): ${len(p)}`);
        // 回転基準系と moonPos がどちらも実位置基準になったので、正三角形は丸め誤差まで
        // 厳密(平均要素で組んでいた頃は角度ずれが距離へ乗り、3% の許容が要った)。
        assert.ok(Math.abs(len(sub(p, moonPos)) - R) < 1e-12 * R, `${name} と月の距離 (t=${t}): ${Math.abs(len(sub(p, moonPos)) - R) / R}`);
        assert.ok(sign * dot(norm(p), lead) > 0, `${name} の前後 (t=${t})`);
      }
    }
  });

  // 太陽-地球系では地球が副天体なので、地心を原点とする ECI での配置は地球-月系と別物になる:
  // L1/L2 は地球の両隣、L3 は太陽の向こう側(地心から約 2 au)、L4/L5 は地心から 1 au。
  test('celestial-motion: 太陽-地球ラグランジュ点は黄道面内にあり、L3 は約2au 太陽側・L4/L5 は正三角形', () => {
    const earth = orbitingMotionOf(parts, 'earth');
    const mu = MU_EARTH / (MU_SUN_LOCAL + MU_EARTH);
    for (const t of [0, 1e7, 1e9]) {
      const sPos = stateOf(parts, 'sun', t).r;
      const R = len(sPos);
      const sHat = norm(sPos);
      const n = earth.orbitNormalAt(t);
      const { L1, L2, L3, L4, L5 } = lagrangeOf(parts, 'earth', t);
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
  test('celestial-motion: 月の黄経は恒星月の平均運動で進む(歳差ぶんの遅速がない)', () => {
    const moonParts = solarSystemParts({ moon: 0 });
    const MOON_ECC = 0.0549;
    const maxCenterDeg = (2 * MOON_ECC * 180) / Math.PI + 0.5;
    for (const days of [27.321661, 365.25, 3652.5]) {
      const t = days * 86400;
      const mean = (2 * Math.PI * (t + TEST_SIM_ZERO_ET)) / MOON_PERIOD;
      let lon = eclipticLongitude(stateOf(moonParts, 'moon', t).r);
      lon += 2 * Math.PI * Math.round((mean - lon) / (2 * Math.PI)); // mean に最も近い分枝へ
      const errDeg = ((lon - mean) * 180) / Math.PI;
      assert.ok(Math.abs(errDeg) < maxCenterDeg, `黄経の平均運動からのずれ (t=${days}日): ${errDeg}°`);
    }
  });

  // 公表されている 18.3°〜28.6° は**平均軌道面**の傾斜なので、平均要素の法線で測る。
  // orbitNormalAt が答えるのは接触軌道面(周期項込み)で、こちらは下のテストが押さえる。
  test('celestial-motion: 月の平均軌道面は昇交点歳差で赤道傾斜 18.3°〜28.6° を掃く', () => {
    const NODE_PERIOD = 18.612958 * 365.25 * 86400;
    let minDeg = 180;
    let maxDeg = 0;
    for (let i = 0; i < 64; i++) {
      const n = keplerOrbitNormal(orbitingMotionOf(parts, 'moon').keplerOrbit, (i / 64) * NODE_PERIOD);
      const deg = (Math.acos(Math.max(-1, Math.min(1, dot(n, v3(0, 1, 0))))) * 180) / Math.PI;
      minDeg = Math.min(minDeg, deg);
      maxDeg = Math.max(maxDeg, deg);
    }
    assert.ok(Math.abs(minDeg - 18.294) < 0.2, `最小傾斜: ${minDeg}°`);
    assert.ok(Math.abs(maxDeg - 28.584) < 0.2, `最大傾斜: ${maxDeg}°`);
  });

  // orbitNormalAt は接触軌道面(太陽摂動の周期項を含む実状態から組む)を答える。平均軌道面の
  // まわりを揺れるだけで、離れ続けることはない — 節周期1回で最大 0.81°(実測)。
  test('celestial-motion: 月の接触軌道面は平均軌道面から 1° 以上離れない', () => {
    const NODE_PERIOD = 18.612958 * 365.25 * 86400;
    const moon = orbitingMotionOf(parts, 'moon');
    let maxDeg = 0;
    for (let i = 0; i < 4000; i++) {
      const t = (i / 4000) * NODE_PERIOD;
      const d = dot(moon.orbitNormalAt(t), keplerOrbitNormal(moon.keplerOrbit, t));
      maxDeg = Math.max(maxDeg, (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI);
    }
    assert.ok(maxDeg > 0.2, `周期項が入っていない: ${maxDeg}°`);
    assert.ok(maxDeg < 1, `接触軌道面が平均から離れすぎる: ${maxDeg}°`);
  });

  // TEST_SIM_ZERO_ET はこの見た目の条件そのものから逆算された定数なので、これはその逆算の検算。
  // 平均黄経で合わせているぶん、中心差(地球の e=0.0167 で最大 1.9°)だけ真の方向はずれる。
  test('celestial-motion: t=0 では太陽が +X 方向(昼側)にある', () => {
    const dir = norm(positionOf(solarSystemParts({}), 'sun', 0));
    const offDeg = (Math.acos(dir.x / len(dir)) * 180) / Math.PI;
    assert.ok(offDeg < 3, `t=0 の太陽方向が +X から離れている: ${offDeg}°`);
  });

  // 要素の元期は全天体で J2000 に揃っているので、評価時刻を TEST_SIM_ZERO_ET だけ戻した瞬間の
  // 日心黄経差は Standish 表の L(平均黄経)の差になる。実位置の黄経は真黄経なので、両天体の
  // 中心差(最大 2e: 地球 1.9°・木星 5.6°)ぶんまで離れうる — 元期不整合(78° 級)を捕まえる
  // にはこの幅で足りる。
  test('celestial-motion: 地球と木星の日心黄経差は t=−TEST_SIM_ZERO_ET で J2000 の表の値と一致する', () => {
    const m = solarSystemParts({});
    const t = -TEST_SIM_ZERO_ET;
    const sun = stateOf(m, 'sun', t).r;
    const earthHelio = scale(sun, -1);
    const jupiterHelio = sub(stateOf(m, 'jupiter', t).r, sun);
    const diffDeg = ((eclipticLongitude(jupiterHelio) - eclipticLongitude(earthHelio)) * 180) / Math.PI;
    const expectedDeg = 34.39644051 - 100.46457166;
    const errDeg = ((diffDeg - expectedDeg + 540) % 360) - 180;
    assert.ok(Math.abs(errDeg) < 8, `J2000 の黄経差からのずれ: ${errDeg}°`);
  });

  // 平均黄経の変化率から出る公転周期が、長半径とケプラー第3法則から出る周期と一致すること。
  // 表の a と L̇ が別々の列である以上、両者の整合は転記ミスを直接捕まえる検査になる。
  test('celestial-motion: 各惑星の公転周期はケプラー第3法則と 0.1% 以内で一致する', () => {
    for (const id of ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'] as const) {
      const orbit = planetOrbit(id);
      const fromRate = (2 * Math.PI) / orbit.lRate;
      const fromKepler = 2 * Math.PI * Math.sqrt(orbit.a ** 3 / MU_SUN_LOCAL);
      assert.ok(Math.abs(fromRate / fromKepler - 1) < 1e-3, `${id} の周期: ${fromRate} vs ${fromKepler}`);
    }
  });

  test('celestial-motion: 各惑星の近日点距離 a(1−e) が表の値になる', () => {
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
  test('celestial-motion: 水星の近日点移動は一般相対論込みの 574〜578″/Cy に入る', () => {
    const rateArcsecPerCentury = ((planetOrbit('mercury').lonPeriRate * JULIAN_CENTURY * 180) / Math.PI) * 3600;
    assert.ok(rateArcsecPerCentury > 574 && rateArcsecPerCentury < 578, `水星 ϖ̇: ${rateArcsecPerCentury}″/Cy`);
  });

  // 平均運動は長半径と親の重力定数からケプラー第3法則で導くので、周期の一致は
  // 登録した a と親の μ が実測どおりに噛み合っていることの検算になる。
  test('celestial-motion: 主要衛星の公転周期が実測値と一致する', () => {
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
  test('celestial-motion: ガリレオ衛星の軌道面は木星の赤道面に一致する', () => {
    const pole = orbitingMotionOf(parts, 'jupiter').orientationAt(1e7)!.axis;
    for (const id of ['io', 'europa', 'ganymede', 'callisto'] as const) {
      const offDeg = (Math.acos(dot(orbitingMotionOf(parts, id).orbitNormalAt(1e7), pole)) * 180) / Math.PI;
      assert.ok(offDeg < 1, `${id} の軌道面法線と木星自転軸のなす角: ${offDeg}°`);
    }
  });

  test('celestial-motion: トリトンは海王星の自転に対して逆行する', () => {
    const t = 1e7;
    const neptune = orbitingMotionOf(parts, 'neptune');
    const triton = orbitingMotionOf(parts, 'triton');
    const rel = sub(stateOf(parts, 'triton', t).r, stateOf(parts, 'neptune', t).r);
    const relVel = sub(stateOf(parts, 'triton', t).v, stateOf(parts, 'neptune', t).v);
    const h = cross(rel, relVel);
    const pole = neptune.orientationAt(t)!.axis;
    assert.ok(dot(h, pole) < 0, `トリトンの軌道角運動量が順行している: ${dot(norm(h), pole)}`);
  });

  // 準惑星・大型小惑星・彗星核の登録が実測の公転周期・近日点距離と噛み合っていることの検算。
  test('celestial-motion: 準惑星・彗星核の公転周期が実測値の範囲に入る', () => {
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

  test('celestial-motion: ハレー彗星の近日点距離は約0.586auになる', () => {
    const AU = 1.495978707e11;
    const orbit = planetOrbit('halley');
    const q = orbit.a * (1 - orbit.e);
    assert.ok(Math.abs(q / (0.586 * AU) - 1) < 0.02, `ハレー彗星の近日点距離: ${q / AU} au`);
  });

  // 冥王星の近日点は海王星の軌道半径より内側 — 実際の軌道交差を表現できていることの確認。
  test('celestial-motion: 冥王星の近日点距離は海王星の半長径より小さい(軌道交差)', () => {
    const plutoOrbit = planetOrbit('pluto');
    const q = plutoOrbit.a * (1 - plutoOrbit.e);
    assert.ok(q < planetOrbit('neptune').a, `冥王星近日点: ${q}, 海王星半長径: ${planetOrbit('neptune').a}`);
  });

  test('celestial-motion: 地球の spinRotationAt の姿勢は1恒星日でほぼ元へ戻る', () => {
    const earth = orbitingMotionOf(parts, 'earth');
    const q0 = earth.spinRotationAt(0)!.q;
    const q1 = earth.spinRotationAt(SIDEREAL_DAY)!.q;
    // q1 * inverse(q0) の回転角(2倍角の余弦を w から取り出す)が 2π の整数倍に近いかを見る。
    const rel = qMul(q1, qInvert(q0));
    const angle = 2 * Math.acos(Math.min(1, Math.abs(rel.w)));
    assert.ok(angle < 1e-6, `1恒星日後の残差角: ${angle}`);
  });

  test('celestial-motion: 地球の spinRotationAt の姿勢は自転中も omega と整合する', () => {
    const earth = orbitingMotionOf(parts, 'earth');
    const t = SIDEREAL_DAY / 3;
    const q0 = earth.spinRotationAt(0)!.q;
    const qt = earth.spinRotationAt(t)!.q;
    const rel = qMul(qt, qInvert(q0));
    const angle = 2 * Math.acos(Math.min(1, Math.abs(rel.w)));
    assert.ok(Math.abs(angle - (2 * Math.PI) / 3) < 1e-6, `経過角: ${angle}`);
    assertOmegaMatchesBasis((time) => earth.spinRotationAt(time)!, t, 1);
  });

  test('celestial-motion: 地球の spinRotationAt の姿勢は時刻とともに自転角だけ進む', () => {
    const earth = orbitingMotionOf(parts, 'earth');
    const q0 = earth.spinRotationAt(0)!.q;
    const quarter = earth.spinRotationAt(SIDEREAL_DAY / 4)!.q;
    const rel = qMul(quarter, qInvert(q0));
    const angle = 2 * Math.acos(Math.min(1, Math.abs(rel.w)));
    assert.ok(Math.abs(angle - Math.PI / 2) < 1e-9, `1/4恒星日後の姿勢差: ${angle}`);
  });

  test('celestial-motion: 地球の spinRotationAt の omega の大きさは 2π/恒星日 に一致する', () => {
    const { omega } = orbitingMotionOf(parts, 'earth').spinRotationAt(12345)!;
    const expected = (2 * Math.PI) / SIDEREAL_DAY;
    assert.ok(Math.abs(len(omega) - expected) / expected < 1e-6, `|omega|: ${len(omega)} vs ${expected}`);
  });

  test('celestial-motion: spinRotationAt は自転モデルを持たない天体(ceres)で null', () => {
    assert.equal(orbitingMotionOf(parts, 'ceres').spinRotationAt(0), null);
  });

  // 公転回転系(orbitFrameRotationAt)が ẑ に軌道面法線・x̂ に中心天体→天体を置くのに合わせ、
  // 自転回転系は ẑ に自転軸・x̂ に本初子午線を置く。ここが崩れると、自転系だけ軸の意味が
  // 変わってしまい、同じパネルで選んだ2つの座標系が別の規約で回る。
  test('celestial-motion: spinRotationAt の基底は ẑ = 自転軸、x̂ = 本初子午線', () => {
    const earth = orbitingMotionOf(parts, 'earth');
    const t = 98765;
    const { axis, spinAngle } = earth.orientationAt(t)!;
    const { q } = earth.spinRotationAt(t)!;
    const zHat = qRotate(q, v3(0, 0, 1));
    const xHat = qRotate(q, v3(1, 0, 0));
    const meridian = meridianDirection(axis, spinAngle);
    assert.ok(len(sub(zHat, axis)) < 1e-9, `ẑ: ${JSON.stringify(zHat)} vs ${JSON.stringify(axis)}`);
    assert.ok(len(sub(xHat, meridian)) < 1e-9, `x̂: ${JSON.stringify(xHat)} vs ${JSON.stringify(meridian)}`);
  });

  // 逆行自転は軸を反転せずに角速度の符号で表す — 金星の omega は IAU の北極と逆を向く。
  test('celestial-motion: 逆行自転(金星)の omega は自転軸と逆向き', () => {
    const t = 4242;
    const venus = orbitingMotionOf(parts, 'venus');
    const { axis } = venus.orientationAt(t)!;
    const { omega } = venus.spinRotationAt(t)!;
    assert.ok(dot(omega, axis) < 0, `dot: ${dot(omega, axis)}`);
  });

  // 数値暦の有効期間(CELESTIAL.md 2.2)を10日間だけに絞ったモックで、期間内/外の
  // 境界をまたいで stateAt/orbitFrameRotationAt/orbitNormalAt を呼ぶ。ECI 原点天体(地球)が
  // 収録されていなければどの天体もパック経路を通らないので、地球は入れておく。
  const numericValidDays = 10;
  const atOrigin = () => ({ r: v3(0, 0, 0), v: v3(0, 0, 0) });
  const mockNumeric: EphemerisPoints = testEphemerisPoints(
    0, numericValidDays * DAY, {
      sun: atOrigin,
      earth: atOrigin,
      moon: () => ({ r: v3(4e8, 0, 0), v: v3(0, 1e3, 0) }),
    },
  );
  const analyticParts = solarSystemParts({});
  const numericParts = solarSystemParts({}, TEST_EPOCH, mockNumeric);
  const numericMoon = orbitingMotionOf(numericParts, 'moon');
  const tOutsideValidity = (numericValidDays + 5) * DAY;

  test('celestial-motion: 数値暦の有効期間内では数値暦由来の値を返す', () => {
    const s = stateOf(numericParts, 'moon', 0);
    assert.ok(len(s.r) > 0 && Number.isFinite(len(s.r)));
    assert.notEqual(s.r.x, stateOf(analyticParts, 'moon', 0).r.x);
  });

  test('celestial-motion: 有効期間を過ぎると例外を投げずに解析暦へフォールバックする', () => {
    assert.doesNotThrow(() => stateOf(numericParts, 'moon', tOutsideValidity));
    assert.doesNotThrow(() => numericMoon.orbitFrameRotationAt(tOutsideValidity));
    assert.doesNotThrow(() => numericMoon.orbitNormalAt(tOutsideValidity));
    const fallback = stateOf(numericParts, 'moon', tOutsideValidity);
    const analytic = stateOf(analyticParts, 'moon', tOutsideValidity);
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
