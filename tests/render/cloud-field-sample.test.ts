// 巻雲の筋の倍角ベクトル(雲場の B・A)の基準式の不変条件を固定する。筋は向きを持たない線
// なので θ と θ+π が同じ値になること、揃い度 0 が向きではなく 0 ベクトルになることが、
// 補間の壊れない持ち方の根拠。
import * as assert from 'node:assert/strict';
import {
  CIRRUS_FLOW_SPEED_FULL, CIRRUS_FLOW_SPEED_ONSET, cirrusFlowFromWind,
} from '../../src/render/cloud/cirrus-flow';
import { test } from '../harness';

const CLOSE = 1e-12;

// θ [rad]・速さ [m/s] の風の倍角ベクトルが、定義 (cos 2θ, sin 2θ) × 揃い度 へ一致するか。
function assertFlow(angleRad: number, speedMs: number): void {
  const flow = cirrusFlowFromWind(Math.cos(angleRad) * speedMs, Math.sin(angleRad) * speedMs);
  const t = Math.min(Math.max(
    (speedMs - CIRRUS_FLOW_SPEED_ONSET) / (CIRRUS_FLOW_SPEED_FULL - CIRRUS_FLOW_SPEED_ONSET), 0), 1);
  const alignment = t * t * (3 - 2 * t);
  assert.ok(Math.abs(flow.east - Math.cos(2 * angleRad) * alignment) < CLOSE);
  assert.ok(Math.abs(flow.north - Math.sin(2 * angleRad) * alignment) < CLOSE);
}

export function register(): void {
  test('cirrus flow: 倍角ベクトルは定義 (cos 2θ, sin 2θ) × 揃い度 に一致する', () => {
    for (const deg of [0, 15, 45, 80, 90, 120, 170]) {
      for (const speed of [10, 20, 40]) assertFlow((deg * Math.PI) / 180, speed);
    }
  });

  test('cirrus flow: θ と θ+π の風は同じ倍角ベクトルを焼く', () => {
    for (const deg of [10, 45, 90, 135]) {
      const theta = (deg * Math.PI) / 180;
      const a = cirrusFlowFromWind(Math.cos(theta) * 20, Math.sin(theta) * 20);
      const b = cirrusFlowFromWind(-Math.cos(theta) * 20, -Math.sin(theta) * 20);
      assert.ok(Math.abs(a.east - b.east) < CLOSE);
      assert.ok(Math.abs(a.north - b.north) < CLOSE);
    }
  });

  test('cirrus flow: 弱い風と無風は 0 ベクトル(向きの既定値を出さない)', () => {
    for (const flow of [
      cirrusFlowFromWind(0, 0),
      cirrusFlowFromWind(3, 4), // ちょうど下の端 5 m/s
      cirrusFlowFromWind(1, 0),
    ]) {
      assert.ok(Math.abs(flow.east) < CLOSE);
      assert.ok(Math.abs(flow.north) < CLOSE);
    }
  });

  test('cirrus flow: 揃い度は 5 m/s で 0、30 m/s で 1 へ滑らかに張り付く', () => {
    const speeds = [5, 10, 17.5, 25, 30, 50];
    let previous = 0;
    for (const speed of speeds) {
      const flow = cirrusFlowFromWind(speed, 0);
      const alignment = Math.hypot(flow.east, flow.north);
      assert.ok(alignment >= previous);
      previous = alignment;
    }
    assert.ok(Math.abs(previous - 1) < CLOSE); // 30 m/s 以上は揃い度 1
    // 30 m/s の東風は (1, 0) に張り付く。
    const flow = cirrusFlowFromWind(30, 0);
    assert.ok(Math.abs(flow.east - 1) < CLOSE);
    assert.ok(Math.abs(flow.north) < CLOSE);
  });

  test('cirrus flow: 北東 45° の風は sin 2θ = 1 の筋になる', () => {
    const flow = cirrusFlowFromWind(30 / Math.SQRT2, 30 / Math.SQRT2);
    assert.ok(Math.abs(flow.east) < 1e-9);
    assert.ok(Math.abs(flow.north - 1) < 1e-9);
  });
}
