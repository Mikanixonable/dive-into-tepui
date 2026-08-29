import * as assert from 'node:assert/strict';
import {
  atmosphericMaxStep, dragTakesFullAirspeed, simulationStepDuration,
} from '../../src/game/dynamic/time-step';
import { test } from '../harness';
import { v3 } from '../../src/math/vec3';
import { kinematicState } from '../../src/physics/kinematic-state';
import { CelestialBody } from '../../src/physics/celestial-body';
import { Atmosphere } from '../../src/physics/atmosphere';

// 基準楕円体の半径がちょうど 1000 の真球で、層は1つだけの試験用の大気。高度がそのまま読める。
const UNIT_ATMOSPHERE: Atmosphere = {
  equatorRadius: 1000, polarRadius: 1000, spinRate: 0, layers: [[0, 1, 100]], pole: v3(0, 1, 0),
};

// center を中心に静止した、大気を持つ/持たない天体。
function body(atmosphere: Atmosphere | null, center = v3()): CelestialBody {
  return {
    id: 'b', mu: 1e6, radius: 1000, state: kinematicState(0, center, v3()), accel: v3(),
    degree2: null, atmosphere, isStar: false,
  };
}

// 高度 alt を降下速度 rate で降りている状態。
function descending(alt: number, rate = 100): ReturnType<typeof kinematicState> {
  return kinematicState(0, v3(1000 + alt, 0, 0), v3(-rate, 0, 0));
}

export function register(): void {
  test('time-step: known event boundary is never crossed', () => {
    assert.equal(simulationStepDuration(100, 200, 20, 107.5), 7.5);
  });

  test('time-step: frame and maximum-step boundaries still apply without an earlier event', () => {
    assert.equal(simulationStepDuration(100, 110, 20, null), 10);
    assert.equal(simulationStepDuration(100, 200, 20, 150), 20);
  });

  test('time-step: 大気の上限は高度に対して単調で、しきい値による飛びを持たない', () => {
    // 刻みを縛るのは連続量(密度とスケールハイト)だけなので、高度をどれだけ細かく掃いても
    // 隣り合う高度の間で刻みが跳ねてはならない。跳べば、ある高度を跨いだ瞬間に費用と精度が
    // 不連続に変わる。
    const bodies = [body(UNIT_ATMOSPHERE)];
    let prev = atmosphericMaxStep(descending(0), 1e-3, bodies);
    for (let alt = 1; alt <= 2000; alt++) {
      const step = atmosphericMaxStep(descending(alt), 1e-3, bodies);
      assert.ok(step >= prev, `高度 ${alt} で刻みが縮んだ: ${prev} → ${step}`);
      assert.ok(step <= prev * 2 + 1e-9, `高度 ${alt} で刻みが跳んだ: ${prev} → ${step}`);
      prev = step;
    }
  });

  test('time-step: 大気の上限が刻みを 0 へ潰すことはない', () => {
    // 幾何級数的に潰れる刻み(Zeno)はサブステップを空回りさせる。抗力の逆時定数もスケール
    // ハイトも有限なので、下限は必ず正で押さえられる。
    const bodies = [body(UNIT_ATMOSPHERE)];
    for (let alt = -500; alt <= 3000; alt += 7) {
      for (const rate of [0, 1, 100, 10000]) {
        const step = atmosphericMaxStep(descending(alt, rate), 1, bodies);
        assert.ok(step > 1e-6, `高度 ${alt}・降下 ${rate} で刻みが潰れた: ${step}`);
      }
    }
  });

  test('time-step: 抗力を受けない物体と、大気の無いところに上限は無い', () => {
    // 刻みを縛っているのは抗力そのものなので、抗力が恒等的にゼロなら縛る理由がない。
    const onSurface = descending(0);
    assert.equal(atmosphericMaxStep(onSurface, 0, [body(UNIT_ATMOSPHERE)]), Infinity);
    assert.equal(atmosphericMaxStep(onSurface, 1, [body(null)]), Infinity);
    assert.equal(atmosphericMaxStep(onSurface, 1, []), Infinity);
  });

  test('time-step: 濃い空気にいるほど、速いほど刻みは短い', () => {
    const bodies = [body(UNIT_ATMOSPHERE)];
    const low = atmosphericMaxStep(descending(0), 1e-3, bodies);
    assert.ok(low < atmosphericMaxStep(descending(1000), 1e-3, bodies));
    assert.ok(low < atmosphericMaxStep(descending(0, 1), 1e-3, bodies));
  });

  test('time-step: 抵抗が大きい物体ほど刻みは短い', () => {
    // 抗力の逆時定数 λ は bcInv に比例する。降下していない状態で見る — 沈み込みの上限は
    // 弾道係数に依らないので、降下中はそちらが先に効いて差が出ないことがある。
    const bodies = [body(UNIT_ATMOSPHERE)];
    const level = kinematicState(0, v3(1000, 0, 0), v3(0, 0, 100));
    assert.ok(atmosphericMaxStep(level, 1e-2, bodies) < atmosphericMaxStep(level, 1e-3, bodies));
  });

  test('time-step: 高度は ECI 原点ではなく、その大気天体の中心から測る', () => {
    // 天体を原点から遠くへ置く。原点基準で測っていれば「はるか高空」に見えるが、その天体から
    // 見れば大気の底にいる。
    const center = v3(0, 0, 5e7);
    const inside = kinematicState(0, v3(0, 0, 5e7 + 1000), v3(0, 0, -100));
    const atCenter = descending(0);
    assert.equal(
      atmosphericMaxStep(inside, 1e-3, [body(UNIT_ATMOSPHERE, center)]),
      atmosphericMaxStep(atCenter, 1e-3, [body(UNIT_ATMOSPHERE)]));
  });

  test('time-step: 上昇中でも、濃い空気の中なら刻みは縮む', () => {
    // 縛っているのは境界までの猶予ではなく、いま浴びている抗力そのもの。
    const climbing = kinematicState(0, v3(1000, 0, 0), v3(100, 0, 0));
    assert.ok(atmosphericMaxStep(climbing, 1e-3, [body(UNIT_ATMOSPHERE)]) < 20);
  });

  test('time-step: 抵抗を受けない相手・大気の無い相手は、どんな刻みでも奪い切られない', () => {
    const bodies = [body(UNIT_ATMOSPHERE)];
    assert.equal(dragTakesFullAirspeed(descending(0), 0, bodies, 1e9), false, '抵抗を受けない');
    assert.equal(dragTakesFullAirspeed(descending(0), 1, [body(null)], 1e9), false, '大気が無い');
    assert.equal(dragTakesFullAirspeed(descending(0), 1, [], 1e9), false, '相手がいない');
    assert.equal(dragTakesFullAirspeed(descending(0), 1, bodies, 0), false, '刻みが 0');
  });

  test('time-step: 刻みを広げるほど、奪い切られる高度は上がる', () => {
    const bodies = [body(UNIT_ATMOSPHERE)];
    // 境界高度を二分で求める。低いほど密度が高く、奪い切られやすい。
    const boundary = (dt: number): number => {
      let lo = 0;
      let hi = 4000;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (dragTakesFullAirspeed(descending(mid), 1e-3, bodies, dt)) lo = mid; else hi = mid;
      }
      return (lo + hi) / 2;
    };
    const wide = boundary(200);
    const narrow = boundary(20);
    assert.ok(narrow < wide, `刻み 20 の境界 ${narrow} が刻み 200 の境界 ${wide} より上`);
    // 境界のすぐ外側では奪い切られない。
    assert.equal(dragTakesFullAirspeed(descending(wide + 1), 1e-3, bodies, 200), false);
    assert.equal(dragTakesFullAirspeed(descending(wide - 1), 1e-3, bodies, 200), true);
  });

  test('time-step: 奪い切りの判定は、沈み込みの上限に引きずられない', () => {
    // atmosphericMaxStep は中間段の沈み込みでも刻みを縛るので、大気から遥かに離れていても
    // 有限の値を返す。奪い切りの判定がその合成値を根拠にすると、空気の無いところの物体まで
    // 巻き込んで消える。
    const bodies = [body(UNIT_ATMOSPHERE)];
    const farAbove = descending(3000); // スケールハイト 30 個ぶん上 = 密度は e^-30
    assert.ok(
      atmosphericMaxStep(farAbove, 1e-3, bodies) < 1e4,
      '前提: 沈み込みの上限が有限の刻みを要求している');
    assert.equal(
      dragTakesFullAirspeed(farAbove, 1e-3, bodies, 1e4), false,
      '空気が無いのに奪い切られている');
  });
}
