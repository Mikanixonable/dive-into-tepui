// attractor.ts の回帰テスト。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import {
  Attractor,
  attractorAccel,
  elementsAround,
  gravityAccel,
  localOrbitPeriod,
  strongestAttractor,
} from '../../src/physics/attractor';
import { MU_EARTH, R_EARTH, keplerPeriod, orbitState, stateFromElements, tofBetween } from '../../src/physics/orbital';
import { Ephemeris, MU_MOON, MU_SUN, R_MOON, R_SUN } from '../../src/physics/ephemeris';
import { add, addScaled, len, norm, sub, v3 } from '../../src/physics/vec3';

const ZERO = v3(0, 0, 0);
const EARTH: Attractor = { id: 'earth', mu: MU_EARTH, radius: R_EARTH, state: orbitState(0, ZERO, ZERO) };

export function register(): void {
  test('attractor: gravityAccel skips a zero-distance body (自分自身) and stays finite', () => {
    const r = v3(R_EARTH + 420e3, 0, 0);
    // moon がクエリ位置と同じ座標(距離ゼロ)にある人工の配置。飛ばされず加算されると
    // μ/0³ で発散する。
    const coincidentMoon: Attractor = { id: 'moon', mu: MU_MOON, radius: R_MOON, state: orbitState(0, r, ZERO) };
    const a = gravityAccel(r, [EARTH, coincidentMoon]);
    assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z), `finite: ${JSON.stringify(a)}`);
    const expectedMag = MU_EARTH / (len(r) * len(r));
    assert.ok(Math.abs(len(a) - expectedMag) / expectedMag < 1e-9, `earth 単独の寄与に一致: ${len(a)} vs ${expectedMag}`);
  });

  test('attractor: 分解の恒等式 Σ attractorAccel(r,b) == gravityAccel(r,bodies) - gravityAccel(0,bodies)', () => {
    const ephemeris = new Ephemeris(0.3, 0.4);
    const bodies = ephemeris.attractorsAt(12345);
    const r = v3(R_EARTH + 420e3, 1.2e6, -3e5);

    let sumX = 0, sumY = 0, sumZ = 0;
    for (const body of bodies) {
      const a = attractorAccel(r, body);
      sumX += a.x; sumY += a.y; sumZ += a.z;
    }
    const rhs = sub(gravityAccel(r, bodies), gravityAccel(ZERO, bodies));
    const diff = len(v3(sumX - rhs.x, sumY - rhs.y, sumZ - rhs.z));
    assert.ok(diff / len(rhs) < 1e-9, `恒等式の誤差: ${diff} (|rhs|=${len(rhs)})`);
  });

  test('attractor: strongestAttractor は LEO で earth', () => {
    const ephemeris = new Ephemeris(0, 0);
    const bodies = ephemeris.attractorsAt(0);
    const r = v3(R_EARTH + 420e3, 0, 0);
    assert.equal(strongestAttractor(r, bodies).id, 'earth');
  });

  test('attractor: strongestAttractor は月から30,000kmでmoon、50,000kmでearthに切り替わる', () => {
    const ephemeris = new Ephemeris(0, 0);
    const bodies = ephemeris.attractorsAt(0);
    const moon = bodies.find((b) => b.id === 'moon')!;
    const towardEarth = (dist: number) => addScaled(moon.state.r, norm(moon.state.r), -dist);
    assert.equal(strongestAttractor(towardEarth(30_000e3), bodies).id, 'moon', '月から30,000km');
    assert.equal(strongestAttractor(towardEarth(50_000e3), bodies).id, 'earth', '月から50,000km');
  });

  test('attractor: strongestAttractor は素の引力でなくattractorAccelで比べる(地心1e9mでearth、5e9mでsun)', () => {
    const ephemeris = new Ephemeris(0, 0);
    const bodies = ephemeris.attractorsAt(0);
    // 素の引力 μ/d² で比べると太陽は地心 2.6e5 km 手前で既に地球に勝ってしまう回帰。
    assert.equal(strongestAttractor(v3(1e9, 0, 0), bodies).id, 'earth', '地心 1e9 m');
    assert.equal(strongestAttractor(v3(5e9, 0, 0), bodies).id, 'sun', '地心 5e9 m');
  });

  test('attractor: localOrbitPeriod は LEO で約5,580秒、月面+100kmで約7,066秒(実測値をピン留め)', () => {
    const ephemeris = new Ephemeris(0, 0);
    const bodies = ephemeris.attractorsAt(0);
    const leoPeriod = localOrbitPeriod(v3(R_EARTH + 420e3, 0, 0), bodies);
    assert.ok(Math.abs(leoPeriod - 5580) / 5580 < 0.01, `LEO 周期: ${leoPeriod}`);

    const moon = bodies.find((b) => b.id === 'moon')!;
    const nearMoon = addScaled(moon.state.r, norm(moon.state.r), R_MOON + 100e3);
    const moonPeriod = localOrbitPeriod(nearMoon, bodies);
    assert.ok(Math.abs(moonPeriod - 7066) / 7066 < 0.01, `月面+100km 周期: ${moonPeriod}`);
  });

  test('attractor: elementsAround が Elements.mu を伝え、月中心の tofBetween が MU_MOON 基準の周期と一致する(回帰)', () => {
    // 月中心の円軌道。mu を渡し忘れて地球の mu で計算すると半周期の飛行時間が
    // sqrt(MU_EARTH/MU_MOON) ~= 9 倍ずれる。
    const moon: Attractor = {
      id: 'moon', mu: MU_MOON, radius: R_MOON,
      state: orbitState(0, v3(3.844e8, 0, 0), v3(0, 0, 1023)),
    };
    const a = R_MOON + 100e3;
    const rel = stateFromElements(0, a, 0, (10 * Math.PI) / 180, 0, 0, 0, MU_MOON);
    const s = orbitState(0, add(rel.r, moon.state.r), add(rel.v, moon.state.v));

    const el = elementsAround(s, moon);
    assert.ok(el, 'elementsAround should not be null');
    assert.equal(el!.mu, MU_MOON);
    const half = tofBetween(el!, 0, Math.PI);
    const expected = keplerPeriod(a, MU_MOON) / 2;
    assert.ok(Math.abs(half - expected) / expected < 1e-6, `半周期の飛行時間: ${half} vs ${expected}`);
  });

  test('ephemeris: attractorsAt は同一 t で同じ配列参照を返す', () => {
    const ephemeris = new Ephemeris(0.1, 0.2);
    const a = ephemeris.attractorsAt(1000);
    const b = ephemeris.attractorsAt(1000);
    assert.equal(a, b, '同一 t の再呼び出しは同じ配列参照');
  });

  test('ephemeris: attractorsAt は直近2件をメモに保つ(t を交互に引いても両方メモに乗る)', () => {
    const ephemeris = new Ephemeris(0.1, 0.2);
    const a1 = ephemeris.attractorsAt(1000);
    const b1 = ephemeris.attractorsAt(2000);
    const a2 = ephemeris.attractorsAt(1000);
    const b2 = ephemeris.attractorsAt(2000);
    assert.equal(a1, a2, 't=1000 が2件メモの片方として残っている');
    assert.equal(b1, b2, 't=2000 が2件メモの片方として残っている');
  });

  test('ephemeris: attractorsAt は [earth, moon, sun] の順で、moonPosAt/sunPosAt と整合する', () => {
    const ephemeris = new Ephemeris(0.1, 0.2);
    const bodies = ephemeris.attractorsAt(5000);
    assert.deepEqual(bodies.map((b) => b.id), ['earth', 'moon', 'sun']);
    assert.deepEqual(bodies[0]!.state.r, ZERO, '地球は原点に静止');
    assert.deepEqual(bodies[1]!.state.r, ephemeris.moonPosAt(5000));
    assert.deepEqual(bodies[2]!.state.r, ephemeris.sunPosAt(5000));
    assert.equal(bodies[0]!.mu, MU_EARTH);
    assert.equal(bodies[1]!.mu, MU_MOON);
    assert.equal(bodies[2]!.mu, MU_SUN);
    assert.equal(bodies[2]!.radius, R_SUN);
  });
}
