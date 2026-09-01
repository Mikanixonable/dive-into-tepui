// attractor.ts(重力源としての天体の読み方)の回帰テスト。
import { fixedMotion, positionOf, solarSystemParts } from './test-helpers';
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { attractorAccel, localOrbitPeriod, orbitingAttractorOf, strongestAttractor } from '../../src/physics/attractor';
import { CelestialMotion } from '../../src/physics/celestial-motion';
import { orbitalElementsOf } from '../../src/physics/elements';
import { kinematicState } from '../../src/physics/kinematic-state';
import { MU_EARTH, R_EARTH, SIDEREAL_DAY } from '../../src/game/celestial/solar-system/constants';
import { keplerPeriod, stateFromOrbitalElements, tofBetween } from '../../src/physics/elements';
import { MU_MOON, MU_SUN, R_MOON, R_SUN } from '../../src/game/celestial/solar-system/constants';
import { add, addScaled, len, norm, sub, v3 } from '../../src/math/vec3';

const ZERO = v3(0, 0, 0);
const EARTH: CelestialMotion = fixedMotion({ id: 'earth', mu: MU_EARTH, radius: R_EARTH, state: kinematicState<'eci'>(0, ZERO, ZERO), accel: ZERO, degree2: null, atmosphere: null });

export function register(): void {
  // 天体の外挿は state.t の前後どちらへも効く必要がある — 掃引はサブステップの中点で
  // 組んだ天体を、区間の始点(過去)と終点(未来)の両方へ動かす。
  test('celestialMotion: pivot の前後へ等加速度で外挿する', () => {
    const body: CelestialMotion = fixedMotion({
      id: 'body', mu: 0, radius: 1, accel: v3(0, 3, 0), degree2: null, atmosphere: null,
      state: kinematicState<'eci'>(100, v3(1000, 0, 0), v3(0, 20, 0)),
    });
    for (const s of [-30, 0, 45]) {
      const got = body.stateAt(100, 100 + s);
      assert.equal(got.t, 100 + s);
      assert.deepEqual(got.r, v3(1000, 20 * s + 1.5 * s * s, 0));
      assert.deepEqual(got.v, v3(0, 20 + 3 * s, 0));
    }
  });

  test('attractor: attractorAccel は原点天体(地球)では素の中心重力になる', () => {
    const r = v3(R_EARTH + 420e3, 0, 0);
    const a = attractorAccel(r, EARTH, 0, 0);
    const expectedMag = MU_EARTH / (len(r) * len(r));
    assert.ok(Math.abs(len(a) - expectedMag) / expectedMag < 1e-9, `μ/r² に一致: ${len(a)} vs ${expectedMag}`);
    assert.ok(a.x < 0, '地心方向を向く');
  });

  test('attractor: attractorAccel は距離ゼロの天体(自分自身)で発散しない', () => {
    const r = v3(R_EARTH + 420e3, 0, 0);
    // moon がクエリ位置と同じ座標(距離ゼロ)にある人工の配置。飛ばされず加算されると
    // μ/0³ で発散する。
    const coincidentMoon: CelestialMotion = fixedMotion({ id: 'moon', mu: MU_MOON, radius: R_MOON, state: kinematicState<'eci'>(0, r, ZERO), accel: ZERO, degree2: null, atmosphere: null });
    const a = attractorAccel(r, coincidentMoon, 0, coincidentMoon.stateAt(0).t);
    assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z), `finite: ${JSON.stringify(a)}`);
    // 直接引力の項だけが落ちて、原点補正項(月が地球を引く分)は残る。
    const expectedMag = MU_MOON / (len(r) * len(r));
    assert.ok(Math.abs(len(a) - expectedMag) / expectedMag < 1e-9, `原点補正項のみ残る: ${len(a)} vs ${expectedMag}`);
  });

  test('attractor: attractorAccel は差分潮汐式 μ[(r_b−r)/|r_b−r|³ − r_b/|r_b|³] に一致', () => {
    const celestialBodies = solarSystemParts({ earth: 0.3, moon: 0.4 }).system.celestialMotions;
    const r = v3(R_EARTH + 420e3, 1.2e6, -3e5);

    for (const celestialBody of celestialBodies.filter((b) => b.id !== 'earth')) {
      const attractorR = celestialBody.stateAt(0).r;
      const rho = sub(attractorR, r);
      const d3 = Math.pow(len(rho), 3);
      const b3 = Math.pow(len(attractorR), 3);
      const expected = sub(
        v3((celestialBody.def.mu * rho.x) / d3, (celestialBody.def.mu * rho.y) / d3, (celestialBody.def.mu * rho.z) / d3),
        v3((celestialBody.def.mu * attractorR.x) / b3, (celestialBody.def.mu * attractorR.y) / b3, (celestialBody.def.mu * attractorR.z) / b3),
      );
      const a = attractorAccel(r, celestialBody, 0, 0);
      const diff = len(sub(a, expected));
      // mu=0(質量未測定)の天体は expected が恒等的に 0 ベクトルになるので、相対誤差ではなく
      // 絶対誤差で見る。
      const ok = len(expected) === 0 ? diff < 1e-15 : diff / len(expected) < 1e-9;
      assert.ok(ok, `${celestialBody.id} の誤差: ${diff} (|expected|=${len(expected)})`);
    }
  });

  test('attractor: strongestAttractor は LEO で earth', () => {
    const celestialBodies = solarSystemParts({ moon: 0 }).system.celestialMotions;
    const r = v3(R_EARTH + 420e3, 0, 0);
    assert.equal(strongestAttractor(r, celestialBodies, 0).id, 'earth');
  });

  test('attractor: strongestAttractor は月から30,000kmでmoon、50,000kmでearthに切り替わる', () => {
    const celestialBodies = solarSystemParts({ moon: 0 }).system.celestialMotions;
    const moon = celestialBodies.find((b) => b.id === 'moon')!;
    const towardEarth = (dist: number) => addScaled(moon.stateAt(0).r, norm(moon.stateAt(0).r), -dist);
    assert.equal(strongestAttractor(towardEarth(30_000e3), celestialBodies, 0).id, 'moon', '月から30,000km');
    assert.equal(strongestAttractor(towardEarth(50_000e3), celestialBodies, 0).id, 'earth', '月から50,000km');
  });

  test('attractor: strongestAttractor は素の引力でなくattractorAccelで比べる(地心1e9mでearth、5e9mでsun)', () => {
    const celestialBodies = solarSystemParts({ moon: 0 }).system.celestialMotions;
    // 素の引力 μ/d² で比べると太陽は地心 2.6e5 km 手前で既に地球に勝ってしまう回帰。
    assert.equal(strongestAttractor(v3(1e9, 0, 0), celestialBodies, 0).id, 'earth', '地心 1e9 m');
    assert.equal(strongestAttractor(v3(5e9, 0, 0), celestialBodies, 0).id, 'sun', '地心 5e9 m');
  });

  test('attractor: localOrbitPeriod は LEO で約5,580秒、月面+100kmで約7,066秒(実測値をピン留め)', () => {
    const celestialBodies = solarSystemParts({ moon: 0 }).system.celestialMotions;
    const leoPeriod = localOrbitPeriod(v3(R_EARTH + 420e3, 0, 0), celestialBodies, 0);
    assert.ok(Math.abs(leoPeriod - 5580) / 5580 < 0.01, `LEO 周期: ${leoPeriod}`);

    const moon = celestialBodies.find((b) => b.id === 'moon')!;
    const nearMoon = addScaled(moon.stateAt(0).r, norm(moon.stateAt(0).r), R_MOON + 100e3);
    const moonPeriod = localOrbitPeriod(nearMoon, celestialBodies, 0);
    assert.ok(Math.abs(moonPeriod - 7066) / 7066 < 0.01, `月面+100km 周期: ${moonPeriod}`);
  });

  test('attractor: orbitalElementsOf が中心天体を伝え、月中心の tofBetween が MU_MOON 基準の周期と一致する(回帰)', () => {
    // 月中心の円軌道。mu を渡し忘れて地球の mu で計算すると半周期の飛行時間が
    // sqrt(MU_EARTH/MU_MOON) ~= 9 倍ずれる。
    const moon: CelestialMotion = fixedMotion({
      id: 'moon', mu: MU_MOON, radius: R_MOON, accel: ZERO, degree2: null, atmosphere: null,
      state: kinematicState<'eci'>(0, v3(3.844e8, 0, 0), v3(0, 0, 1023)),
    });
    const a = R_MOON + 100e3;
    const rel = stateFromOrbitalElements(0, a, 0, (10 * Math.PI) / 180, 0, 0, 0, MU_MOON);
    const s = kinematicState<'eci'>(0, add(rel.r, moon.stateAt(0).r), add(rel.v, moon.stateAt(0).v));

    const el = orbitalElementsOf(s, moon, 0);
    assert.ok(el, 'orbitalElementsOf should not be null');
    assert.equal(el!.center.def.mu, MU_MOON);
    const half = tofBetween(el!, 0, Math.PI);
    const expected = keplerPeriod(a, MU_MOON) / 2;
    assert.ok(Math.abs(half - expected) / expected < 1e-6, `半周期の飛行時間: ${half} vs ${expected}`);
  });

  test('celestialMotions: 同じ pivot を引くたび同じ値を返す', () => {
    const windows = solarSystemParts({ earth: 0.1, moon: 0.2 }).system;
    const a = windows.celestialMotions;
    const b = windows.celestialMotions;
    assert.deepEqual(a, b);
  });

  test('celestialMotions: 太陽系の宣言順で並び、天体の運動と整合する', () => {
    const parts = solarSystemParts({ earth: 0.1, moon: 0.2 });
    const windows = parts.system;
    const celestialBodies = windows.celestialMotions;
    assert.deepEqual(celestialBodies.map((b) => b.id), ['earth', 'moon', 'mercury', 'venus', 'mars', 'phobos', 'deimos', 'jupiter', 'metis', 'adrastea', 'amalthea', 'thebe', 'io', 'europa', 'ganymede', 'callisto', 'himalia', 'elara', 'ananke', 'carme', 'pasiphae', 'sinope', 'saturn', 'pan', 'daphnis', 'prometheus', 'pandora', 'epimetheus', 'janus', 'mimas', 'enceladus', 'tethys', 'dione', 'rhea', 'titan', 'hyperion', 'iapetus', 'phoebe', 'uranus', 'puck', 'miranda', 'ariel', 'umbriel', 'titania', 'oberon', 'neptune', 'triton', 'nereid', 'ceres', 'vesta', 'pallas', 'pluto', 'charon', 'styx', 'nix', 'kerberos', 'hydra', 'haumea', 'hiiaka', 'namaka', 'makemake', 'eris', 'dysnomia', 'halley', 'encke', 'sedna', 'quaoar', 'weywot', 'chariklo', 'hygiea', 'eros', 'ryugu', 'bennu', 'orcus', 'vanth', 'gonggong', 'salacia', 'varuna', 'ixion', 'arrokoth', 'chiron', 'interamnia', 'europa52', 'davida', 'juno', 'psyche', 'eunomia', 'sylvia', 'apophis', 'didymos', 'tempel1', 'wild2', 'hartley2', 'cruithne', 'kamooalewa', 'tk7', 'eureka', 'sun']);
    // 天体を1つ挿入しても静かに別天体を指さないよう、添字ではなく id で引く。
    const byId = (id: string) => celestialBodies.find((b) => b.id === id)!;
    assert.deepEqual(byId('earth').stateAt(5000).r, ZERO, '地球は原点に静止');
    assert.deepEqual(byId('moon').stateAt(5000).r, positionOf(parts, 'moon', 5000));
    assert.deepEqual(byId('jupiter').stateAt(5000).r, positionOf(parts, 'jupiter', 5000));
    assert.deepEqual(byId('sun').stateAt(5000).r, positionOf(parts, 'sun', 5000));
    assert.equal(byId('earth').def.mu, MU_EARTH);
    assert.equal(byId('moon').def.mu, MU_MOON);
    assert.equal(byId('sun').def.mu, MU_SUN);
    assert.equal(byId('sun').def.radius, R_SUN);
  });

  // 参照フレームの「役割の公転」を選択肢に出すかどうかがこの判定に乗っている。周回して
  // いない対象の公転は定義できないので、選択肢そのものを出さないための入口。
  test('orbitingAttractorOf: 楕円軌道なら主天体、脱出速度以上なら null', () => {
    const bodies = solarSystemParts().system.celestialMotions.filter((b) => b.id === 'earth');
    const r = v3(7e6, 0, 0);
    const vCirc = Math.sqrt(MU_EARTH / 7e6);
    assert.equal(orbitingAttractorOf(kinematicState<'eci'>(0, r, v3(0, vCirc, 0)), bodies, 0)?.id, 'earth');
    // 脱出速度の 1.2 倍は双曲線軌道(e >= 1)。
    assert.equal(orbitingAttractorOf(kinematicState<'eci'>(0, r, v3(0, vCirc * Math.SQRT2 * 1.2, 0)), bodies, 0), null);
  });
}
