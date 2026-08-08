// ephemeris.ts の回帰テスト: Ephemeris クラスの合成(恒星→重心→惑星/衛星、重心補正)
// が正しいこと。個々の軌道モデルの精度は kepler-orbit.test.ts / satellite-orbit.test.ts が担う。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { Ephemeris } from '../../src/physics/ephemeris';
import { MU_EARTH, R_EARTH } from '../../src/physics/kinematic-state';
import { MU_MOON, MU_SUN as MU_SUN_LOCAL, SOLAR_SYSTEM } from '../../src/physics/solar-system';
import { EPS } from '../../src/physics/ecliptic';
import { PlanetOrbit } from '../../src/physics/planet-orbit';
import { keplerOrbitState } from '../../src/physics/kepler-orbit';
import { cross, dot, len, norm, scale, sub, v3 } from '../../src/physics/vec3';

const YEAR = 365.25636 * 86400;
const MOON_PERIOD = 27.321661 * 86400;
// 地球-月重心の日心ケプラー軌道(SOLAR_SYSTEM の宣言そのもの)。重心不変条件の
// 検証で Ephemeris の合成結果と突き合わせる基準として使う。
const EARTH_ORBIT: PlanetOrbit = (SOLAR_SYSTEM.earth as { orbit: PlanetOrbit }).orbit;

export function register(): void {
  const eph = new Ephemeris({ earth: 0.3, moon: 0.4 });

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
      const baryHelio = keplerOrbitState(EARTH_ORBIT, t, 0.3);
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
      const bary = keplerOrbitState(EARTH_ORBIT, t, 0.3);
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
      assert.ok(dot(norm(L1), sHat) > 0.999999, `L1 が太陽側でない (t=${t})`);
      assert.ok(dot(norm(L2), sHat) < -0.999999, `L2 が反太陽側でない (t=${t})`);
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
    const moonEph = new Ephemeris({ moon: 0 });
    const MOON_ECC = 0.0549;
    const maxCenterDeg = (2 * MOON_ECC * 180) / Math.PI + 0.5;
    for (const days of [27.321661, 365.25, 3652.5]) {
      const t = days * 86400;
      const mean = (2 * Math.PI * t) / MOON_PERIOD;
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

  test('ephemeris: sunDirAt は単位ベクトルで、positionOf(sun) と同じ向き', () => {
    for (const t of [0, 1e6, 1e8]) {
      const dir = eph.sunDirAt(t);
      assert.ok(Math.abs(len(dir) - 1) < 1e-12, `単位ベクトルでない: ${len(dir)}`);
      const pos = eph.positionOf('sun', t);
      assert.ok(len(sub(dir, norm(pos))) < 1e-12, `方向が positionOf(sun) と一致しない`);
    }
  });

  test('ephemeris: attractorsAt は SOLAR_SYSTEM の宣言順で、地球は静止・半径は R_EARTH', () => {
    const attractors = eph.attractorsAt(1234);
    assert.deepEqual(attractors.map((b) => b.id), ['earth', 'moon', 'jupiter', 'sun']);
    assert.equal(attractors[0]!.radius, R_EARTH);
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
