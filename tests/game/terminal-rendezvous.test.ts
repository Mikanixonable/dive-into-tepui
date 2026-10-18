// 終端誘導つき会合遷移の回帰テスト。待機点・接近点の距離への到達、保持点として
// 相対運動が閉じること、ノード列の時刻単調を固定する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { motionOf, solarSystemParts } from '../physics/test-helpers';
import { planRendezvous } from '../../src/game/navigation/terminal-rendezvous';
import { keplerPeriod, orbitalElementsOf, stateOnOrbitAt } from '../../src/physics/elements';
import { kinematicState, type KinematicState } from '../../src/physics/kinematic-state';
import { add, cross, dot, len, lenSq, norm, scale, sub, v3 } from '../../src/math/vec3';
import type { CelestialMotion } from '../../src/physics/celestial-motion';
import type { TransferPlannerTarget } from '../../src/physics/transfer-planner';
import { MU_EARTH } from '../../src/game/celestial/solar-system/earth-system';

const R1 = 7_000e3;
const R2 = 20_000e3;
const T0 = 1_000;

// 地球を周る仮想衛星の状態源(出発側と同じ赤道面の円軌道)。
function circularTarget(phase0: number): TransferPlannerTarget {
  const vCirc = Math.sqrt(MU_EARTH / R2);
  const n = Math.sqrt(MU_EARTH / R2 ** 3);
  const earth = motionOf(solarSystemParts(), 'earth');
  return {
    stateAt: (t: number) => {
      const ct = earth.stateAt(t);
      const th = phase0 + n * (t - T0);
      return kinematicState<'eci'>(
        t,
        add(ct.r, v3(R2 * Math.cos(th), 0, R2 * Math.sin(th))),
        add(ct.v, v3(-vCirc * Math.sin(th), 0, vCirc * Math.cos(th))),
      );
    },
    period: keplerPeriod(R2, MU_EARTH),
  };
}

function shipOnLeo(earth: CelestialMotion): KinematicState {
  const c0 = earth.stateAt(T0);
  return kinematicState<'eci'>(
    T0, add(c0.r, v3(R1, 0, 0)), add(c0.v, v3(0, 0, Math.sqrt(MU_EARTH / R1))));
}

// ノードが目標に対して持つ相対位置(目標引き)と、回転系内での保持誤差。
// 戻り値は [相対距離, 局所系での相対速度の大きさ]。系内速度は v_ship−v_target−ω×r_rel。
function relativeMeasure(
  node: KinematicState, targetState: KinematicState, centerState: KinematicState,
): [number, number] {
  const relR = sub(targetState.r, centerState.r);
  const relV = sub(targetState.v, centerState.v);
  const omega = scale(cross(relR, relV), 1 / lenSq(relR));
  const rRel = sub(node.r, targetState.r);
  const vInFrame = sub(sub(node.v, targetState.v), cross(omega, rRel));
  return [len(rRel), len(vInFrame)];
}

// ノードの噴射後状態を二体伝播したとき、目標との距離が保持範囲に留まるか。
// 保持点は回転系の固定点なので、自由飛行でも相対距離は発散しないはず。
function holdsNear(
  node: KinematicState, earth: CelestialMotion, target: TransferPlannerTarget, distance: number,
): boolean {
  const el = orbitalElementsOf(node, earth, node.t);
  if (el === null) return false;
  for (const dt of [1_000, 2_000]) {
    const coasted = stateOnOrbitAt(el, node.t + dt);
    const targetState = target.stateAt(node.t + dt);
    if (coasted === null || targetState === null) return false;
    const sep = len(sub(add(coasted.r, earth.stateAt(node.t + dt).r), targetState.r));
    if (sep < distance * 0.5 || sep > distance * 2) return false;
  }
  return true;
}

export function register(): void {
  test('terminal-rendezvous: 待機点へ着く — 距離・相対速度・時刻単調', () => {
    const earth = motionOf(solarSystemParts(), 'earth');
    const distance = 10_000;
    const target = circularTarget(0.7);
    const cands = planRendezvous(
      shipOnLeo(earth), earth, target, { kind: 'standoff', distance });
    assert.ok(cands.length > 0, '候補が1件も無い');
    for (const c of cands) {
      assert.equal(c.nodes.length, 2);
      assert.ok(c.nodes[0].t === c.departAt && c.nodes[1].t === c.arriveAt);
      // 末尾ノードは目標の後方 distance の待機点で、系内速度はほぼ 0(保持)。
      const last = c.nodes[c.nodes.length - 1];
      const targetState = target.stateAt(last.t);
      assert.ok(targetState !== null);
      const tgt = earth.stateAt(last.t);
      const [sep, vHold] = relativeMeasure(last, targetState, tgt);
      assert.ok(Math.abs(sep - distance) < distance * 0.01, `待機点距離 ${sep} m`);
      assert.ok(vHold < 1e-6, `系内相対速度 ${vHold} m/s`);
      // 進行方向成分が負 = 目標の後方。
      const pro = norm(sub(targetState.v, tgt.v));
      assert.ok(dot(sub(last.r, targetState.r), pro) < -distance * 0.99);
      // 保持点から自由飛行しても目標との距離は発散しない。
      assert.ok(holdsNear(last, earth, target, distance));
    }
  });

  test('terminal-rendezvous: 接近点へ着く — 待機点経由の CW 末段と時刻単調', () => {
    const earth = motionOf(solarSystemParts(), 'earth');
    const distance = 200;
    const target = circularTarget(0.7);
    const cands = planRendezvous(
      shipOnLeo(earth), earth, target, { kind: 'approach', distance });
    assert.ok(cands.length > 0, '候補が1件も無い');
    for (const c of cands) {
      assert.equal(c.nodes.length, 4);
      for (let i = 1; i < c.nodes.length; i++) {
        assert.ok(c.nodes[i].t > c.nodes[i - 1].t, 'ノード時刻が単調でない');
      }
      // 末尾ノードは目標の後方 distance の接近点で、系内速度はほぼ 0(保持)。
      const last = c.nodes[c.nodes.length - 1];
      const tgtState = target.stateAt(last.t);
      assert.ok(tgtState !== null);
      const [sep, vHold] = relativeMeasure(last, tgtState, earth.stateAt(last.t));
      assert.ok(Math.abs(sep - distance) < distance * 0.01, `接近点距離 ${sep} m`);
      assert.ok(vHold < 1e-6, `系内相対速度 ${vHold} m/s`);
      // 慣性の相対速度は n·d ≈ 0.23 m/s — 接近点の仕様(0.3 m/s 以下)の内側。
      assert.ok(len(sub(last.v, tgtState.v)) < 0.3);
      // 中間ノードは待機点(終端入口) — 目標からの距離は 10 km 級。
      const mid = c.nodes[2];
      const midTarget = target.stateAt(mid.t);
      assert.ok(midTarget !== null);
      const [midSep] = relativeMeasure(mid, midTarget, earth.stateAt(mid.t));
      assert.ok(Math.abs(midSep - 10_000) < 10_000 * 0.01, `待機点距離 ${midSep} m`);
      assert.ok(holdsNear(last, earth, target, distance));
    }
  });
}
