// predict.ts の回帰テスト。
// - predictTrajectory はアンカー起点で積分し、各ノード時刻で状態を postState へ
//   リセットして継続する(相対 Δv を積むのではなく、実行後の絶対状態へ差し替える)。
// - arrivingStates は各ノードに到達する直前(噴射前)の状態を求める。ノードが1個で
//   その arc 長 = 予測期間のとき、ノード無し予測の終端状態と一致するはず(同一積分)。
// 数値予測の絶対値そのものは実測基準(RK4 の刻み・間引きに依存)なので、往復・自己
// 整合の形で挙動を固定する。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { MU_EARTH, R_EARTH, orbitState } from '../../src/physics/orbital';
import {
  PlannedNode,
  arrivingStates,
  predictTrajectory,
  sampleAt,
} from '../../src/physics/predict';
import { Ephemeris } from '../../src/physics/ephemeris';
import { len, scale, sub, v3 } from '../../src/physics/vec3';

// 決定的な位相(既定の moonPhase0 は乱数なので明示指定する)。
const EPHEMERIS = new Ephemeris(0, 0);
const MAX_SAMPLES = 2000;

// 420km 円軌道(赤道面)の状態。
function circularState() {
  const r0 = R_EARTH + 420e3;
  const vc = Math.sqrt(MU_EARTH / r0);
  return orbitState(v3(r0, 0, 0), v3(0, vc, 0));
}

export function register(): void {
  test('predict: no-node trajectory stays a bounded orbit (radius near-constant)', () => {
    const s0 = circularState();
    const r0 = len(s0.r);
    const samples = predictTrajectory(s0, 0, 3000, [], EPHEMERIS, MAX_SAMPLES);
    assert.ok(samples.length > 2, 'expected multiple samples');
    // 円軌道なので全サンプルの動径は初期値付近に留まる。J2(赤道扁平)と第三体で
    // 0.1〜数% 程度は変動するので、暴走しない範囲を実測基準で緩く固定する。
    for (const s of samples) {
      assert.ok(Math.abs(len(s.r) - r0) / r0 < 1e-2, 'radius drifted too much on circular orbit');
    }
  });

  test('predict: state is reset to node.postState at the node time', () => {
    const s0 = circularState();
    const nodeTime = 1500;
    // postState は「到達状態と明確に違う」速度(1.1倍)を与える。
    // predictTrajectory はノード時刻でこの状態へリセットするはず。
    const post = orbitState(v3(R_EARTH + 420e3, 0, 0), scale(v3(0, Math.sqrt(MU_EARTH / (R_EARTH + 420e3)), 0), 1.1));
    const node: PlannedNode = { time: nodeTime, postState: post };
    const samples = predictTrajectory(s0, 0, 3000, [node], EPHEMERIS, MAX_SAMPLES);
    // ノード時刻ちょうどのサンプル = リセット後(postState)。
    const at = sampleAt(samples, nodeTime);
    assert.ok(at, 'expected a sample at the node time');
    assert.ok(len(sub(at!.r, post.r)) < 1, 'post-node position should equal postState.r');
    assert.ok(len(sub(at!.v, post.v)) < 1e-6, 'post-node velocity should equal postState.v');
  });

  test('predict: arrivingStates matches free propagation to the node time (single node)', () => {
    const s0 = circularState();
    const nodeTime = 1500;
    // 1ノードのとき arriving[0] は postState に依存しない(上流のみで決まる)。
    // 適当な postState でよい。
    const node: PlannedNode = { time: nodeTime, postState: orbitState(v3(R_EARTH + 420e3, 0, 0), v3(0, 0, 0)) };
    const arriving = arrivingStates(s0, 0, [node], EPHEMERIS);
    assert.equal(arriving.length, 1);

    // ノード無しで nodeTime まで積分した終端(同一の刻み系列)と一致するはず。
    const free = predictTrajectory(s0, 0, nodeTime, [], EPHEMERIS, MAX_SAMPLES);
    const end = free[free.length - 1]!;
    assert.ok(Math.abs(end.t - nodeTime) < 1e-6, 'free propagation should end at node time');
    assert.ok(len(sub(arriving[0]!.r, end.r)) < 1e-6, 'arriving position should match free propagation');
    assert.ok(len(sub(arriving[0]!.v, end.v)) < 1e-9, 'arriving velocity should match free propagation');
  });

  test('predict: zero-Δv node (postState = arriving) leaves the orbit continuous', () => {
    const s0 = circularState();
    const nodeTime = 1500;
    const arriving = arrivingStates(s0, 0, [{ time: nodeTime, postState: s0 }], EPHEMERIS)[0]!;
    // Δv=0 のノード(postState = 到達状態)。ノード前後で状態が連続するはず。
    const node: PlannedNode = { time: nodeTime, postState: arriving };
    const samples = predictTrajectory(s0, 0, 3000, [node], EPHEMERIS, MAX_SAMPLES);
    const at = sampleAt(samples, nodeTime);
    assert.ok(at, 'expected a sample at node time');
    assert.ok(len(sub(at!.v, arriving.v)) < 1e-6, 'zero-Δv node should not jump velocity');
  });
}
