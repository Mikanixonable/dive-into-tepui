import * as assert from 'node:assert/strict';
import {
  SPHERE_LOD_LADDER,
  sphereLodLevel,
  sphereLodLevelWithHysteresis,
  sphereLodTransitionThresholds,
} from '../../src/render/screen-lod';
import { test } from '../harness';

export function register(): void {
  test('screen lod: 初回選択は純粋で不正値を決定的に処理する', () => {
    assert.strictEqual(sphereLodLevel(0), SPHERE_LOD_LADDER[0]);
    assert.strictEqual(sphereLodLevel(-1), SPHERE_LOD_LADDER[0]);
    assert.strictEqual(sphereLodLevel(Number.NaN), SPHERE_LOD_LADDER[0]);
    assert.strictEqual(sphereLodLevel(Number.POSITIVE_INFINITY), SPHERE_LOD_LADDER.at(-1));
    assert.strictEqual(sphereLodLevel(2_000), SPHERE_LOD_LADDER[1]);
  });

  test('screen lod: 近づくときはシルエット誤差の境界で細かくする', () => {
    const boundary = sphereLodTransitionThresholds(0)!;
    assert.strictEqual(
      sphereLodLevelWithHysteresis(boundary.enterDiameterPx, SPHERE_LOD_LADDER[0]),
      SPHERE_LOD_LADDER[0],
    );
    assert.strictEqual(
      sphereLodLevelWithHysteresis(boundary.enterDiameterPx + 1, SPHERE_LOD_LADDER[0]),
      SPHERE_LOD_LADDER[1],
    );
  });

  test('screen lod: 遠ざかるときは退出境界まで細かい段を維持する', () => {
    const boundary = sphereLodTransitionThresholds(0)!;
    assert.ok(boundary.exitDiameterPx < boundary.enterDiameterPx);
    assert.strictEqual(
      sphereLodLevelWithHysteresis(boundary.exitDiameterPx + 1, SPHERE_LOD_LADDER[1]),
      SPHERE_LOD_LADDER[1],
    );
    assert.strictEqual(
      sphereLodLevelWithHysteresis(boundary.exitDiameterPx, SPHERE_LOD_LADDER[1]),
      SPHERE_LOD_LADDER[0],
    );
  });

  test('screen lod: 閾値内の往復はチャタリングせず、段飛びも安定する', () => {
    const first = sphereLodTransitionThresholds(0)!;
    const second = sphereLodTransitionThresholds(1)!;
    const finer = sphereLodLevelWithHysteresis(first.enterDiameterPx + 1, SPHERE_LOD_LADDER[0]);
    assert.strictEqual(
      sphereLodLevelWithHysteresis((first.enterDiameterPx + first.exitDiameterPx) / 2, finer),
      SPHERE_LOD_LADDER[1],
    );
    assert.strictEqual(
      sphereLodLevelWithHysteresis(first.exitDiameterPx, SPHERE_LOD_LADDER[1]),
      SPHERE_LOD_LADDER[0],
    );
    assert.strictEqual(
      sphereLodLevelWithHysteresis(Number.POSITIVE_INFINITY, SPHERE_LOD_LADDER[0]),
      SPHERE_LOD_LADDER.at(-1),
    );
    assert.strictEqual(
      sphereLodLevelWithHysteresis(Number.NEGATIVE_INFINITY, SPHERE_LOD_LADDER.at(-1)!),
      SPHERE_LOD_LADDER[0],
    );
    assert.ok(second.exitDiameterPx < second.enterDiameterPx);
    assert.strictEqual(
      sphereLodLevelWithHysteresis(second.enterDiameterPx, SPHERE_LOD_LADDER[1]),
      SPHERE_LOD_LADDER[1],
    );
    const secondFiner = sphereLodLevelWithHysteresis(
      second.enterDiameterPx + 1, SPHERE_LOD_LADDER[1],
    );
    assert.strictEqual(secondFiner, SPHERE_LOD_LADDER[2]);
    assert.strictEqual(
      sphereLodLevelWithHysteresis(
        (second.enterDiameterPx + second.exitDiameterPx) / 2, secondFiner,
      ),
      SPHERE_LOD_LADDER[2],
    );
    const secondCoarser = sphereLodLevelWithHysteresis(
      second.exitDiameterPx, secondFiner,
    );
    assert.strictEqual(secondCoarser, SPHERE_LOD_LADDER[1]);
    assert.strictEqual(
      sphereLodLevelWithHysteresis(
        (second.enterDiameterPx + second.exitDiameterPx) / 2, secondCoarser,
      ),
      SPHERE_LOD_LADDER[1],
    );
  });

  test('screen lod: offは段を隠し再有効化時に初期選択へ戻る', () => {
    const boundary = sphereLodTransitionThresholds(0)!;
    const hidden = sphereLodLevelWithHysteresis(
      boundary.enterDiameterPx + 1, SPHERE_LOD_LADDER[1], false,
    );
    assert.equal(hidden, null);
    assert.strictEqual(
      sphereLodLevelWithHysteresis(boundary.enterDiameterPx + 1, hidden, true),
      SPHERE_LOD_LADDER[1],
    );
  });
}
