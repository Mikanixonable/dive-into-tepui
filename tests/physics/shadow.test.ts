// shadow.ts の回帰テスト。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { maxOccludedFraction, sunlitFactor } from '../../src/physics/shadow';
import { CelestialBody } from '../../src/physics/celestial-body';
import { kinematicState } from '../../src/physics/kinematic-state';
import { MU_EARTH, MU_MOON, MU_SUN, R_EARTH, R_MOON, R_SUN } from '../../src/physics/solar-system';
import { len, sub, v3 } from '../../src/physics/vec3';

const AU = 1.495978707e11;

function star(x: number): CelestialBody {
  return { id: 'sun', mu: MU_SUN, radius: R_SUN, state: kinematicState(0, v3(x, 0, 0), v3(0, 0, 0)), accel: v3(), degree2: null, atmosphere: null, isStar: true };
}

function body(id: string, mu: number, radius: number, x: number): CelestialBody {
  return { id, mu, radius, state: kinematicState(0, v3(x, 0, 0), v3(0, 0, 0)), accel: v3(), degree2: null, atmosphere: null, isStar: false };
}

export function register(): void {
  test('shadow: sunlitFactor は遮蔽天体が無ければ常に 1', () => {
    const sun = star(AU);
    for (const r of [v3(1e6, 0, 0), v3(0, R_EARTH, 0), v3(-1e5, 7e6, 0)]) {
      assert.equal(sunlitFactor(r, sun, []), 1, `r=${JSON.stringify(r)}`);
    }
  });

  test('shadow: sunlitFactor は地球の本影の中心で 0', () => {
    const sun = star(AU);
    const earth = body('earth', MU_EARTH, R_EARTH, 0);
    const r = v3(-R_EARTH * 2, 0, 0); // 反太陽側、地球の真後ろの軸上
    assert.equal(sunlitFactor(r, sun, [earth]), 0);
  });

  test('shadow: sunlitFactor は半影帯を横切ると 0..1 の間を単調に変化し、内側は本影で 0、外側は完全日照で 1 になる', () => {
    const sun = star(AU);
    const earth = body('earth', MU_EARTH, R_EARTH, 0);
    const along = -2e7; // 反太陽側、地球からじゅうぶん離れた本影の中
    // 軸からの角距離を、地球・太陽の視半径の和のやや外側まで線形に振る — 完全日照へ抜ける。
    const earthAngRadius = R_EARTH / Math.abs(along);
    const sunAngRadius = R_SUN / AU;
    const maxAngSep = (earthAngRadius + sunAngRadius) * 1.5;
    let prev = -1;
    const steps = 12;
    for (let i = 0; i <= steps; i++) {
      const perp = (i / steps) * maxAngSep * Math.abs(along);
      const lit = sunlitFactor(v3(along, perp, 0), sun, [earth]);
      assert.ok(lit >= 0 && lit <= 1, `範囲外 (i=${i}): ${lit}`);
      assert.ok(lit >= prev - 1e-9, `軸から離れて減光が増さない (i=${i}): ${lit} < ${prev}`);
      prev = lit;
    }
    assert.equal(sunlitFactor(v3(along, 0, 0), sun, [earth]), 0, '軸上(本影の中心)は 0');
    assert.ok(prev > 0.99, '半影帯の外側でほぼ完全日照');
  });

  test('shadow: sunlitFactor は月の影(日食)でも減光する', () => {
    const sun = star(AU);
    const moonDist = 3.844e8;
    const moon = body('moon', MU_MOON, R_MOON, moonDist);
    const r = v3(moonDist - R_MOON * 3, 0, 0); // 月を挟んで太陽の反対側、月からじゅうぶん近い本影
    const lit = sunlitFactor(r, sun, [moon]);
    assert.ok(lit < 1, `月の影で減光しない: ${lit}`);
  });

  test('shadow: 遮蔽天体が艦より太陽から遠い側(背後)にあれば減光しない', () => {
    const sun = star(AU);
    // 地球を艦の反太陽側(背後)に置く — 角度だけ見れば太陽と同一直線上だが、遮蔽ではない。
    const earthBehind = body('earth', MU_EARTH, R_EARTH, -1e7);
    const r = v3(0, 0, 0);
    assert.equal(sunlitFactor(r, sun, [earthBehind]), 1);
  });

  test('shadow: 遮蔽円盤が太陽円盤に完全に内包される配置(金環)で 1-(r/R)^2 になる', () => {
    // 太陽視半径 rSun = R_SUN/AU、月視半径 rMoon = R_MOON/moonDist を、月をじゅうぶん
    // 太陽に近い側(rMoon << rSun)に置くことで内包させる — 遮蔽天体側が完全に太陽円盤に収まる。
    const sun = star(AU);
    const moonDist = AU * 0.9; // 太陽のすぐ手前
    const moon = body('moon', MU_MOON, R_MOON, moonDist);
    const r = v3(0, 0, 0);
    const rSun = R_SUN / AU;
    const rOcc = R_MOON / (moonDist);
    assert.ok(rOcc < rSun, '前提: 遮蔽円盤の方が小さい');
    const lit = sunlitFactor(r, sun, [moon]);
    const expected = 1 - (rOcc / rSun) ** 2;
    assert.ok(Math.abs(lit - expected) / expected < 1e-6, `金環: got ${lit}, expected ${expected}`);
  });

  test('shadow: LEO(R/d が小角近似で破綻する距離)でターミネータ角が asin(R/d) の幾何と一致する', () => {
    // 太陽は原点から遠方 +X、地球は原点。艦は +X 軸(太陽方向)との成す角 theta を振りながら
    // 高度 420km の円軌道上を動く。太陽は実質無限遠にあるとみなせるので、r から見た太陽方向は
    // ほぼ常に +X — 一方 r から地球中心への方向と太陽方向との角度差(sep)は 180° - theta。
    // 地球の視半径ちょうど分だけ太陽方向から離れた時に地平線(地球の縁)を太陽がかすめるので、
    // ターミネータは sep = asin(R_EARTH / r_orbit)、すなわち theta = 180° - asin(R_EARTH / r_orbit)
    // に来るはず — 小角近似 (R/d をラジアンとみなす) では大きくずれる距離であることが前提。
    const sun = star(AU);
    const earth = body('earth', MU_EARTH, R_EARTH, 0);
    const rOrbit = R_EARTH + 420000;
    const ratio = R_EARTH / rOrbit;
    assert.ok(ratio > 0.9, `前提: R/d が小角近似の破綻する大きさ (got ${ratio})`);

    const litAt = (thetaDeg: number): number => {
      const theta = (thetaDeg * Math.PI) / 180;
      const r = v3(rOrbit * Math.cos(theta), rOrbit * Math.sin(theta), 0);
      return sunlitFactor(r, sun, [earth]);
    };

    // 二分探索で日照率が 0.5 を切る角度(ターミネータ)を求める。
    let lo = 90;
    let hi = 180;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (litAt(mid) >= 0.5) lo = mid; else hi = mid;
    }
    const measuredTerminatorDeg = (lo + hi) / 2;

    const geometricDeg = 180 - (Math.asin(ratio) * 180) / Math.PI;
    const smallAngleDeg = 180 - (ratio * 180) / Math.PI; // 小角近似(誤り)での予測

    assert.ok(
      Math.abs(measuredTerminatorDeg - geometricDeg) < 1,
      `asin による幾何予測と一致しない: measured=${measuredTerminatorDeg}, geometric(asin)=${geometricDeg}`
    );
    assert.ok(
      Math.abs(measuredTerminatorDeg - smallAngleDeg) > 5,
      `小角近似と有意に異なることを確認できない: measured=${measuredTerminatorDeg}, smallAngle=${smallAngleDeg}`
    );
  });

  test('shadow: 観測点が天体の内部にあれば 0 を返す', () => {
    const sun = star(AU);
    const earth = body('earth', MU_EARTH, R_EARTH, 0);
    // 地球中心からわずかにオフセットしつつ太陽と反対側(along>0 となる側)に置き、
    // 地球半径よりじゅうぶん内側に収める — 天体内部からは太陽が見えないはず。
    const r = v3(-1e5, 1e5, 0);
    assert.ok(len(sub(earth.state.r, r)) < R_EARTH, '前提: r は地球の内部');
    assert.equal(sunlitFactor(r, sun, [earth]), 0);
  });

  test('shadow: maxOccludedFraction は実際の遮蔽率の上限になっている', () => {
    const sun = star(0);
    const earth = body('earth', MU_EARTH, R_EARTH, AU);
    const moon = body('moon', MU_MOON, R_MOON, AU + 3.844e8);
    // 地球の半影帯・月の半影帯・本影・完全日照をまたぐように観測点を振る。
    for (const occluder of [earth, moon]) {
      for (let i = 0; i <= 40; i++) {
        const along = occluder.state.r.x + 1e6 * 2 ** (i % 10);
        const perp = (i / 40) * occluder.radius * 6;
        const r = v3(along, perp, 0);
        const occluded = 1 - sunlitFactor(r, sun, [occluder]);
        const bound = maxOccludedFraction(r, sun, occluder);
        assert.ok(
          occluded <= bound + 1e-12,
          `上限を超えた (${occluder.id}, i=${i}): occluded=${occluded} > bound=${bound}`,
        );
      }
    }
  });

  test('shadow: maxOccludedFraction で閾値を切った天体を落としても、日照率は閾値以上ずれない', () => {
    // 恒星を原点に置いた太陽系の縮図。金星は地球から見て太陽の手前(太陽面通過)に、
    // 土星圏の衛星は土星のすぐ外側に並ぶ — どちらも「幾何としては確かに遮っているが、
    // 隠す面積が小さいので落としてよい」側に来る。
    const sun = star(0);
    const venus = body('venus', 3.2486e14, 6.0518e6, 1.0821e11);
    const earth = body('earth', MU_EARTH, R_EARTH, AU);
    const moon = body('moon', MU_MOON, R_MOON, AU + 3.844e8);
    const saturnDist = 1.4335e12;
    const saturn = body('saturn', 3.7931187e16, 5.8232e7, saturnDist);
    const titan = body('titan', 8.978e12, 2.5747e6, saturnDist + 1.2219e9);
    const rhea = body('rhea', 1.539e11, 7.635e5, saturnDist + 5.271e8);
    const all = [venus, earth, moon, saturn, titan, rhea];

    const threshold = 1e-2;
    const scenes: readonly (readonly [string, ReturnType<typeof v3>])[] = [
      ['低軌道', v3(AU - (R_EARTH + 4e5), 0, 0)],
      ['月食', v3(AU + 3.844e8, R_MOON * 1.5, 0)],
      ['土星圏', v3(saturnDist - saturn.radius * 3, 0, 0)],
    ];
    for (const [name, r] of scenes) {
      const kept = all.filter((b) => maxOccludedFraction(r, sun, b) >= threshold);
      assert.ok(kept.length < all.length, `${name}: 落ちる天体が1つも無い(前提が成立しない)`);
      const exact = sunlitFactor(r, sun, all);
      const truncated = sunlitFactor(r, sun, kept);
      assert.ok(
        Math.abs(exact - truncated) <= threshold,
        `${name}: 打ち切りの誤差が閾値を超えた exact=${exact} truncated=${truncated}`,
      );
    }
  });

  test('shadow: sunlitFactor は複数の遮蔽天体があっても常に 0..1 に収まる', () => {
    const sun = star(AU);
    const earth = body('earth', MU_EARTH, R_EARTH, 0);
    const moon = body('moon', MU_MOON, R_MOON, 3.844e8);
    for (let i = 0; i < 20; i++) {
      const r = v3((i - 10) * 5e5, (i * 7 - 3) * 3e5, (i * i - 50) * 1e5);
      const lit = sunlitFactor(r, sun, [earth, moon]);
      assert.ok(lit >= 0 && lit <= 1, `範囲外: ${lit}`);
    }
  });
}
