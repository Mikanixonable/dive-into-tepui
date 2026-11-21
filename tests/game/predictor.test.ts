// game/dynamic/predictor.ts の回帰。1フレームの配分が追いつき分(消費される弧の先端を消費前線の
// 先へ出す歩 — 歩数予算の内側で必ず渡し、実時間では削らない)と伸長分(そこから要求終端へ伸ばす
// 歩 — 歩数に加えて実時間の上限も掛ける)に分かれることを、注入した時計で決定的に固定する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { fixedMotion } from '../physics/test-helpers';
import { v3 } from '../../src/math/vec3';
import type { CelestialBody } from '../../src/physics/celestial-body';
import { kinematicState, type KinematicState } from '../../src/physics/kinematic-state';
import { MU_EARTH, R_EARTH } from '../../src/game/celestial/solar-system/earth-system';
import type { CelestialBodies } from '../../src/game/celestial/celestial-bodies';
import { DynamicMotion } from '../../src/game/dynamic/dynamic-motion';
import {
  ARC_MIN_ITEM_STEPS, ARC_STEP_BUDGET, Predictor,
} from '../../src/game/dynamic/predictor';
import type { PredictableMotionRoster } from '../../src/game/dynamic/dynamic-simulation-participant';
import type { TrajectoryDemand } from '../../src/game/dynamic/trajectory-demand';

// 表示期間(予測を伸ばす長さ)は十分に大きく取り、弧が歩数以外では止まらないようにする。
const DAY = 86400;
// 高度 420km の円軌道。大気を持たない地球だけの顔ぶれなので、consumable な弧の刻みは
// simulationMaxStep ちょうど(20s)に揃う — 1歩で先端が 20s 進む。
const STEP_DT = 20;
const DEMAND: TrajectoryDemand = { horizon: DAY, historyDuration: 0, planArcs: [] };

function circularState(): KinematicState<'eci'> {
  const r0 = R_EARTH + 420e3;
  return kinematicState<'eci'>(0, v3(r0, 0, 0), v3(0, Math.sqrt(MU_EARTH / r0), 0));
}

// 大気を持たない地球1体だけの顔ぶれ。地球は ECI 原点に静止する。
function earthOnlyBodies(): readonly CelestialBody[] {
  return [
    fixedMotion({
      id: 'earth', mu: MU_EARTH, radius: R_EARTH,
      state: kinematicState<'eci'>(0, v3(), v3()), accel: v3(), degree2: null, atmosphere: null,
    }),
  ];
}

// 予測器が読む面(登録天体の一覧)の最小の代役。
function celestialBodiesOf(bodies: readonly CelestialBody[]): CelestialBodies {
  return { celestialMotions: bodies } as unknown as CelestialBodies;
}

// 弧をなぞる個体を motions 体ぶんの名簿にする。
function rosterOf(motions: readonly DynamicMotion[]): PredictableMotionRoster {
  return { allMotions: () => motions };
}

function newMotion(): DynamicMotion {
  return new DynamicMotion(circularState(), { followsPredictedArc: true });
}

// 呼ぶたびに step [ms] 進む時計。
function advancingClock(step: number): () => number {
  let t = 0;
  return () => (t += step);
}

function newPredictor(motions: readonly DynamicMotion[], clock: () => number): Predictor {
  return new Predictor(rosterOf(motions), celestialBodiesOf(earthOnlyBodies()), clock);
}

export function register(): void {
  test('predictor: 時計がいくら進んでも、追いつき分(先端を消費前線の先へ出す歩)は削られない', () => {
    // simDt=100s のフレーム: 消費前線は simTime+100。刻み 20s の弧が前線を越えるのに 6 歩要る。
    // 時計が 100ms ずつ進むので伸長分の時限は初読から超過するが、追いつき分は削られない。
    const m = newMotion();
    const predictor = newPredictor([m], advancingClock(100));
    predictor.update(0, 100, m, DEMAND);
    const tip = m.predicted!.state.t;
    assert.ok(tip > 100, `追いつき分は先端を消費前線の先へ出すはず, got ${tip}`);
    const steps = predictor.perfCounts(0, DAY, m).predictorSteps;
    assert.equal(steps, 6, `時限超過で伸長分は 0 になり、追いつき分の 6 歩だけが残るはず, got ${steps}`);
  });

  test('predictor: 背景の個体にも追いつき分は時計に関係なく渡る', () => {
    // simDt=20s のフレーム: 前線を越えるのに 2 歩。15 体すべてが時限超過の中で追いつき分だけ受ける。
    const motions = Array.from({ length: 15 }, () => newMotion());
    const predictor = newPredictor(motions, advancingClock(100));
    predictor.update(0, 20, null, DEMAND);
    for (const [i, m] of motions.entries()) {
      const tip = m.predicted!.state.t;
      assert.ok(tip > 20, `entity ${i}: 追いつき分で先端が消費前線を越えるはず, got ${tip}`);
    }
    const steps = predictor.perfCounts(0, DAY, null).predictorSteps;
    assert.equal(steps, 15 * 2, `各個体 2 歩の追いつき分だけが走るはず, got ${steps}`);
  });

  test('predictor: 追いつき分は1体あたり実シミュレーションの歩数上限(SUBSTEP_MAX_COUNT)まで渡る', () => {
    // simDt=3277s(高ワープ相当): maxStep=3277/64 なので先端が前線に届くのに 64 歩かかる。
    // 64 歩ちょうどでは先端が前線と並ぶ — at(前線) は先端を含むので消費には足りる。
    const m = newMotion();
    const predictor = newPredictor([m], advancingClock(100));
    predictor.update(0, 3277, m, DEMAND);
    const tip = m.predicted!.state.t;
    assert.ok(tip >= 3277, `64 歩で先端が消費前線へ届くはず, got ${tip}`);
    const steps = predictor.perfCounts(0, DAY, m).predictorSteps;
    assert.equal(steps, 64, `追いつき分は 1 体あたり SUBSTEP_MAX_COUNT 歩を上限とする, got ${steps}`);
  });

  test('predictor: 伸長分は時限で打ち切られる', () => {
    // 先に凍った時計で弧を前線より十分先へ伸ばし、追いつき分が 0 の状態にする。
    const m = newMotion();
    const frozen = newPredictor([m], () => 0);
    frozen.update(0, 100, m, DEMAND);
    const ahead = m.predicted!.state.t;
    assert.ok(ahead > 100, `前提: 弧は消費前線の先へ伸びている, got ${ahead}`);

    // 呼ぶたび 1ms 進む時計では、時限判定(8 歩ごと)の 4 回目(24 歩目)で上限に達し、
    // 伸長分はちょうど 24 歩で切れる。
    const timed = newPredictor([m], advancingClock(1));
    timed.update(0, 100, m, DEMAND);
    const steps = timed.perfCounts(0, DAY, m).predictorSteps;
    assert.equal(steps, 24, `伸長分は時限で打ち切られる, got ${steps}`);
    assert.equal(m.predicted!.state.t - ahead, 24 * STEP_DT, '打ち切られた歩数ぶんだけ先端が進む');
  });

  test('predictor: 時計が進まなければ、配分は従来どおりの歩数になる', () => {
    const motions = Array.from({ length: 10 }, () => newMotion());
    const predictor = newPredictor(motions, () => 0);
    predictor.update(0, 100, null, DEMAND); // 全個体を消費前線の先まで伸ばす
    const before = motions.map((m) => m.predicted!.state.t);
    for (const [i, tip] of before.entries()) {
      assert.ok(tip > 100, `前提: entity ${i} の弧が消費前線の先にある, got ${tip}`);
    }

    // 追いつき分が 0 のとき、伸長分の配分は従来の式そのまま — 残予算を残り個体数で均等割り、
    // 下限 ARC_MIN_ITEM_STEPS。
    let remaining = ARC_STEP_BUDGET;
    const expected = before.map((_, i) => {
      const share = Math.max(ARC_MIN_ITEM_STEPS, Math.floor(remaining / (before.length - i)));
      const consumed = Math.min(remaining, share);
      remaining -= consumed;
      return consumed;
    });

    predictor.update(0, 100, null, DEMAND);
    assert.equal(
      predictor.perfCounts(0, DAY, null).predictorSteps, ARC_STEP_BUDGET,
      '前提: 伸びる先が十分あるので予算は使い切る',
    );
    for (const [i, m] of motions.entries()) {
      const advanced = m.predicted!.state.t - before[i]!;
      assert.equal(
        advanced, expected[i]! * STEP_DT,
        `entity ${i}: 従来式の ${expected[i]} 歩ぶんだけ伸びるはず`,
      );
    }
  });

  test('predictor: 背景の個体は予算の続くかぎり ARC_MIN_ITEM_STEPS 以上の伸長分を得て、巡回は残りから再開する', () => {
    // 40 体・simDt=20s(追いつき分 2 歩): share は下限 16 に張り付き、1 体あたり 18 歩を
    // 消費するので 600 歩では 33 体+端数ぶん — 末尾はこのフレームでは捨てられる。
    const motions = Array.from({ length: 40 }, () => newMotion());
    const predictor = newPredictor(motions, () => 0);
    predictor.update(0, 20, null, DEMAND);
    assert.equal(predictor.perfCounts(0, DAY, null).predictorSteps, ARC_STEP_BUDGET);
    const fullTip = (2 + ARC_MIN_ITEM_STEPS) * STEP_DT;
    for (const [i, m] of motions.entries()) {
      if (i < 33) {
        const tip = m.predicted!.state.t;
        assert.ok(tip >= fullTip, `entity ${i}: 追いつき 2 歩 + 下限 16 歩のはず, got ${tip}`);
      } else if (i === 33) {
        const tip = m.predicted!.state.t;
        assert.equal(tip, 6 * STEP_DT, `entity ${i}: 端数でも追いつき分は渡る, got ${tip}`);
      } else {
        assert.equal(m.predicted, null, `entity ${i}: 予算切れでこのフレームは捨てられる`);
      }
    }

    // 巡回は残りから再開するので、前フレームで捨てられた個体は次に先回りされる。
    predictor.update(0, 20, null, DEMAND);
    for (const i of [34, 35, 36, 37, 38, 39]) {
      const tip = motions[i]!.predicted!.state.t;
      assert.ok(tip >= fullTip, `entity ${i}: 前フレームで捨てられた個体にも配分が回るはず, got ${tip}`);
    }
  });
}
