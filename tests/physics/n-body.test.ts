// 相互重力(小惑星どうし)の回帰テスト。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { CelestialBody } from '../../src/physics/celestial-body';
import { stepDynamics } from '../../src/physics/dynamics';
import { kinematicState, KinematicState } from '../../src/physics/kinematic-state';
import { MU_EARTH, R_EARTH } from '../../src/game/celestial/solar-system/constants';
import { Vec3, add, len, scale, sub, v3 } from '../../src/math/vec3';

const ZERO = v3(0, 0, 0);

// 試験用の CelestialBody を組む。質点(degree2 なし)・非恒星・半径0で、重力の寄与だけを見る。
function makeCelestialBody(id: string, mu: number, state: KinematicState): CelestialBody {
  return { id, mu, radius: 0, state, accel: ZERO, degree2: null, atmosphere: null, isStar: false };
}

// 単一の attractor だけを重力源として1ステップ進める(自由伝播: 抵抗・輻射圧・推力なし)。
function stepFree(state: KinematicState, dt: number, attractors: readonly CelestialBody[]): KinematicState {
  return stepDynamics(state, dt, attractors, attractors, null, 0, 0, null);
}

// dt ぶんのステップの間、相手の attractor 位置をステップ開始時点で固定する近似は
// (Simulator が動的な重力源に対して実際に行っているのと同じ近似)、区間中点まで速度で
// 外挿するだけで一次の遅れ誤差を消せる。相互重力の周期検算をわずかなステップ数で
// 高精度に行うための、このテストだけの工夫。
function atMidpoint(state: KinematicState, dt: number): KinematicState {
  return kinematicState(state.t + dt / 2, add(state.r, scale(state.v, dt / 2)), state.v);
}

export function register(): void {
  test('n-body: 対称二体系は独立に導出した周期 T = 2π√(d³/(mu1+mu2)) でちょうど1周する', () => {
    const mu = 1e12;
    const d = 1e5;
    // ECI 原点補正項(attractorAccel 第2項)は原点からの絶対距離だけで決まる非物理的な
    // 混入項なので、系全体を原点から遠く離して相対的に無視できる大きさに抑える
    // (補正/直接項の比は概ね (d/offset)² — offset=1e10 なら 1e-10)。
    const offset = v3(1e10, 0, 0);
    const omega = Math.sqrt((2 * mu) / (d * d * d));
    const period = (2 * Math.PI) / omega;
    const v = omega * (d / 2);

    let a = kinematicState(0, add(offset, v3(d / 2, 0, 0)), v3(0, v, 0));
    let b = kinematicState(0, add(offset, v3(-d / 2, 0, 0)), v3(0, -v, 0));

    const steps = 4000;
    const dt = period / steps;
    for (let i = 0; i < steps; i++) {
      const celestialBodyFromB = makeCelestialBody('b', mu, atMidpoint(b, dt));
      const celestialBodyFromA = makeCelestialBody('a', mu, atMidpoint(a, dt));
      const nextA = stepFree(a, dt, [celestialBodyFromB]);
      const nextB = stepFree(b, dt, [celestialBodyFromA]);
      a = nextA;
      b = nextB;
    }

    const errA = len(sub(a.r, add(offset, v3(d / 2, 0, 0))));
    const errB = len(sub(b.r, add(offset, v3(-d / 2, 0, 0))));
    assert.ok(errA / d < 1e-4, `1周後に出発位置へ戻る(a): 誤差 ${errA} m`);
    assert.ok(errB / d < 1e-4, `1周後に出発位置へ戻る(b): 誤差 ${errB} m`);
  });

  test('n-body: 対称二体系の全運動量 Σ mu_i・v_i が保存される', () => {
    const mu = 1e12;
    const d = 1e5;
    const offset = v3(1e10, 0, 0);
    const omega = Math.sqrt((2 * mu) / (d * d * d));
    const v = omega * (d / 2);
    let a = kinematicState(0, add(offset, v3(d / 2, 0, 0)), v3(0, v, 0));
    let b = kinematicState(0, add(offset, v3(-d / 2, 0, 0)), v3(0, -v, 0));

    const momentum0 = add(scale(a.v, mu), scale(b.v, mu));
    const dt = (2 * Math.PI) / omega / 500;
    for (let i = 0; i < 500; i++) {
      const celestialBodyFromB = makeCelestialBody('b', mu, b);
      const celestialBodyFromA = makeCelestialBody('a', mu, a);
      const nextA = stepFree(a, dt, [celestialBodyFromB]);
      const nextB = stepFree(b, dt, [celestialBodyFromA]);
      a = nextA;
      b = nextB;
    }
    const momentum1 = add(scale(a.v, mu), scale(b.v, mu));
    const drift = len(sub(momentum1, momentum0));
    const scaleMag = mu * v;
    assert.ok(drift / scaleMag < 1e-6, `二体の全運動量が保存される: drift=${drift}`);
  });

  test('n-body: 質量がまちまちな三体系でも全運動量 Σ mu_i・v_i が保存される', () => {
    const offset = v3(0, 0, 1e10);
    // 分離距離(~1e5〜1e6m)に対して mu を控えめに取り、近接遭遇のような急激な加速度変化を避ける
    // (相互重力そのものの精度ではなく、離散ステップが保存則をどれだけ保つかを見たいテストなので)。
    const muA = 1e9, muB = 2e9, muC = 1.5e9;
    let a = kinematicState(0, add(offset, v3(3e5, 0, 0)), v3(0, 30, 5));
    let b = kinematicState(0, add(offset, v3(-2e5, 3e5, 0)), v3(-20, -10, 0));
    let c = kinematicState(0, add(offset, v3(0, -3e5, 2e5)), v3(15, 20, -8));

    const momentumOf = (a2: KinematicState, b2: KinematicState, c2: KinematicState): Vec3 =>
      add(add(scale(a2.v, muA), scale(b2.v, muB)), scale(c2.v, muC));
    const momentum0 = momentumOf(a, b, c);

    const dt = 1;
    for (let i = 0; i < 300; i++) {
      const attractorA = makeCelestialBody('a', muA, a);
      const attractorB = makeCelestialBody('b', muB, b);
      const attractorC = makeCelestialBody('c', muC, c);
      const nextA = stepFree(a, dt, [attractorB, attractorC]);
      const nextB = stepFree(b, dt, [attractorA, attractorC]);
      const nextC = stepFree(c, dt, [attractorA, attractorB]);
      a = nextA; b = nextB; c = nextC;
    }
    const momentum1 = momentumOf(a, b, c);
    const drift = len(sub(momentum1, momentum0));
    const scaleMag = muA * 30; // 代表的な運動量成分のオーダー
    assert.ok(drift / scaleMag < 1e-3, `三体の全運動量が保存される(緩め許容): drift=${drift}`);
  });

  test('n-body: 地球+小天体で艦を積分すると、小天体の質量→0の極限で小天体なしの結果に収束する', () => {
    const earth = makeCelestialBody('earth', MU_EARTH, kinematicState(0, ZERO, ZERO));
    const shipR0 = v3(R_EARTH + 420e3, 0, 0);
    const shipV0 = v3(0, Math.sqrt(MU_EARTH / (R_EARTH + 420e3)), 0);
    const ship0 = kinematicState(0, shipR0, shipV0);
    const smallBodyPos = kinematicState(0, v3(R_EARTH + 420e3 + 2e4, 5e3, 0), ZERO);

    const integrate = (muSmallBody: number): KinematicState => {
      const attractors = muSmallBody === 0 ? [earth] : [earth, makeCelestialBody('small-body', muSmallBody, smallBodyPos)];
      let s = ship0;
      const dt = 1;
      for (let i = 0; i < 200; i++) s = stepFree(s, dt, attractors);
      return s;
    };

    const baseline = integrate(0);
    const small = integrate(1e6);
    const smaller = integrate(1e4);

    const diffSmall = len(sub(small.r, baseline.r));
    const diffSmaller = len(sub(smaller.r, baseline.r));
    assert.ok(diffSmall > 0, '有限質量の小天体はベースラインと異なる軌道を作る');
    // 摂動は小天体の質量にほぼ線形に比例するので、質量を1/100にすれば差も概ね1/100になる。
    assert.ok(diffSmaller < diffSmall / 10,
      `質量→0の極限でベースラインへ収束する: diffSmall=${diffSmall}, diffSmaller=${diffSmaller}`);
  });
}
