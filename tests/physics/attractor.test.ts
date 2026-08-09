// attractor.ts の回帰テスト。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import {
  Attractor,
  attractorAccel,
  orbitalElementsOf,
  localOrbitPeriod,
  strongestAttractor,
} from '../../src/physics/attractor';
import { kinematicState } from '../../src/physics/kinematic-state';
import { MU_EARTH, R_EARTH } from '../../src/physics/solar-system';
import { keplerPeriod, stateFromOrbitalElements, tofBetween } from '../../src/physics/elements';
import { Ephemeris } from '../../src/physics/ephemeris';
import { MU_MOON, MU_SUN, R_MOON, R_SUN } from '../../src/physics/solar-system';
import { add, addScaled, len, norm, sub, v3 } from '../../src/physics/vec3';

const ZERO = v3(0, 0, 0);
const EARTH: Attractor = { id: 'earth', mu: MU_EARTH, radius: R_EARTH, state: kinematicState(0, ZERO, ZERO), degree2: null };

export function register(): void {
  test('attractor: attractorAccel は原点天体(地球)では素の中心重力になる', () => {
    const r = v3(R_EARTH + 420e3, 0, 0);
    const a = attractorAccel(r, EARTH);
    const expectedMag = MU_EARTH / (len(r) * len(r));
    assert.ok(Math.abs(len(a) - expectedMag) / expectedMag < 1e-9, `μ/r² に一致: ${len(a)} vs ${expectedMag}`);
    assert.ok(a.x < 0, '地心方向を向く');
  });

  test('attractor: attractorAccel は距離ゼロの天体(自分自身)で発散しない', () => {
    const r = v3(R_EARTH + 420e3, 0, 0);
    // moon がクエリ位置と同じ座標(距離ゼロ)にある人工の配置。飛ばされず加算されると
    // μ/0³ で発散する。
    const coincidentMoon: Attractor = { id: 'moon', mu: MU_MOON, radius: R_MOON, state: kinematicState(0, r, ZERO), degree2: null };
    const a = attractorAccel(r, coincidentMoon);
    assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z), `finite: ${JSON.stringify(a)}`);
    // 直接引力の項だけが落ちて、原点補正項(月が地球を引く分)は残る。
    const expectedMag = MU_MOON / (len(r) * len(r));
    assert.ok(Math.abs(len(a) - expectedMag) / expectedMag < 1e-9, `原点補正項のみ残る: ${len(a)} vs ${expectedMag}`);
  });

  test('attractor: attractorAccel は差分潮汐式 μ[(r_b−r)/|r_b−r|³ − r_b/|r_b|³] に一致', () => {
    const ephemeris = new Ephemeris({ earth: 0.3, moon: 0.4 });
    const attractors = ephemeris.attractorsAt(12345);
    const r = v3(R_EARTH + 420e3, 1.2e6, -3e5);

    for (const attractor of attractors.filter((b) => b.id !== 'earth')) {
      const attractorR = attractor.state.r;
      const rho = sub(attractorR, r);
      const d3 = Math.pow(len(rho), 3);
      const b3 = Math.pow(len(attractorR), 3);
      const expected = sub(
        v3((attractor.mu * rho.x) / d3, (attractor.mu * rho.y) / d3, (attractor.mu * rho.z) / d3),
        v3((attractor.mu * attractorR.x) / b3, (attractor.mu * attractorR.y) / b3, (attractor.mu * attractorR.z) / b3),
      );
      const a = attractorAccel(r, attractor);
      const diff = len(sub(a, expected));
      assert.ok(diff / len(expected) < 1e-9, `${attractor.id} の誤差: ${diff} (|expected|=${len(expected)})`);
    }
  });

  test('attractor: strongestAttractor は LEO で earth', () => {
    const ephemeris = new Ephemeris({ moon: 0 });
    const attractors = ephemeris.attractorsAt(0);
    const r = v3(R_EARTH + 420e3, 0, 0);
    assert.equal(strongestAttractor(r, attractors).id, 'earth');
  });

  test('attractor: strongestAttractor は月から30,000kmでmoon、50,000kmでearthに切り替わる', () => {
    const ephemeris = new Ephemeris({ moon: 0 });
    const attractors = ephemeris.attractorsAt(0);
    const moon = attractors.find((b) => b.id === 'moon')!;
    const towardEarth = (dist: number) => addScaled(moon.state.r, norm(moon.state.r), -dist);
    assert.equal(strongestAttractor(towardEarth(30_000e3), attractors).id, 'moon', '月から30,000km');
    assert.equal(strongestAttractor(towardEarth(50_000e3), attractors).id, 'earth', '月から50,000km');
  });

  test('attractor: strongestAttractor は素の引力でなくattractorAccelで比べる(地心1e9mでearth、5e9mでsun)', () => {
    const ephemeris = new Ephemeris({ moon: 0 });
    const attractors = ephemeris.attractorsAt(0);
    // 素の引力 μ/d² で比べると太陽は地心 2.6e5 km 手前で既に地球に勝ってしまう回帰。
    assert.equal(strongestAttractor(v3(1e9, 0, 0), attractors).id, 'earth', '地心 1e9 m');
    assert.equal(strongestAttractor(v3(5e9, 0, 0), attractors).id, 'sun', '地心 5e9 m');
  });

  test('attractor: localOrbitPeriod は LEO で約5,580秒、月面+100kmで約7,066秒(実測値をピン留め)', () => {
    const ephemeris = new Ephemeris({ moon: 0 });
    const attractors = ephemeris.attractorsAt(0);
    const leoPeriod = localOrbitPeriod(v3(R_EARTH + 420e3, 0, 0), attractors);
    assert.ok(Math.abs(leoPeriod - 5580) / 5580 < 0.01, `LEO 周期: ${leoPeriod}`);

    const moon = attractors.find((b) => b.id === 'moon')!;
    const nearMoon = addScaled(moon.state.r, norm(moon.state.r), R_MOON + 100e3);
    const moonPeriod = localOrbitPeriod(nearMoon, attractors);
    assert.ok(Math.abs(moonPeriod - 7066) / 7066 < 0.01, `月面+100km 周期: ${moonPeriod}`);
  });

  test('attractor: orbitalElementsOf が中心天体を伝え、月中心の tofBetween が MU_MOON 基準の周期と一致する(回帰)', () => {
    // 月中心の円軌道。mu を渡し忘れて地球の mu で計算すると半周期の飛行時間が
    // sqrt(MU_EARTH/MU_MOON) ~= 9 倍ずれる。
    const moon: Attractor = {
      id: 'moon', mu: MU_MOON, radius: R_MOON, degree2: null,
      state: kinematicState(0, v3(3.844e8, 0, 0), v3(0, 0, 1023)),
    };
    const a = R_MOON + 100e3;
    const rel = stateFromOrbitalElements(0, a, 0, (10 * Math.PI) / 180, 0, 0, 0, MU_MOON);
    const s = kinematicState(0, add(rel.r, moon.state.r), add(rel.v, moon.state.v));

    const el = orbitalElementsOf(s, moon);
    assert.ok(el, 'orbitalElementsOf should not be null');
    assert.equal(el!.center.mu, MU_MOON);
    const half = tofBetween(el!, 0, Math.PI);
    const expected = keplerPeriod(a, MU_MOON) / 2;
    assert.ok(Math.abs(half - expected) / expected < 1e-6, `半周期の飛行時間: ${half} vs ${expected}`);
  });

  test('ephemeris: attractorsAt は同一 t を引くたび同じ値を返す', () => {
    const ephemeris = new Ephemeris({ earth: 0.1, moon: 0.2 });
    const a = ephemeris.attractorsAt(1000);
    const b = ephemeris.attractorsAt(1000);
    assert.deepEqual(a, b);
  });

  test('ephemeris: attractorsAt は SOLAR_SYSTEM の宣言順で、positionOf と整合する', () => {
    const ephemeris = new Ephemeris({ earth: 0.1, moon: 0.2 });
    const attractors = ephemeris.attractorsAt(5000);
    assert.deepEqual(attractors.map((b) => b.id), ['earth', 'moon', 'jupiter', 'sun']);
    // 天体を1つ挿入しても静かに別天体を指さないよう、添字ではなく id で引く。
    const byId = (id: string) => attractors.find((b) => b.id === id)!;
    assert.deepEqual(byId('earth').state.r, ZERO, '地球は原点に静止');
    assert.deepEqual(byId('moon').state.r, ephemeris.positionOf('moon', 5000));
    assert.deepEqual(byId('jupiter').state.r, ephemeris.positionOf('jupiter', 5000));
    assert.deepEqual(byId('sun').state.r, ephemeris.positionOf('sun', 5000));
    assert.equal(byId('earth').mu, MU_EARTH);
    assert.equal(byId('moon').mu, MU_MOON);
    assert.equal(byId('sun').mu, MU_SUN);
    assert.equal(byId('sun').radius, R_SUN);
  });
}
