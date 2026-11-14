// 敵の意図の遷移が、COMBAT.md「AI と射撃」の4状態の規則どおりであることを検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { ENGAGEMENT_RANGE } from '../../src/game/dynamic/engagement-zone';
import {
  ENEMY_INTENT_RENDEZVOUS_RANGE, enemyIntentAllowsFire, nextEnemyIntent,
} from '../../src/game/dynamic/dynamic-entity/enemy-intent';

export function register(): void {
  test('enemy-intent: 交戦圏の内側では射撃姿勢になり、離れていくときだけ離脱になる', () => {
    const inRange = ENGAGEMENT_RANGE - 1;
    assert.equal(nextEnemyIntent('approach', inRange, -10), 'firing-posture');
    assert.equal(nextEnemyIntent('firing-posture', inRange, 0), 'firing-posture');
    assert.equal(nextEnemyIntent('firing-posture', inRange, 10), 'departure');
    assert.equal(nextEnemyIntent('departure', inRange, -10), 'firing-posture');
  });

  test('enemy-intent: 圏外では接近と再会合が距離の帯で分かれ、巡回する', () => {
    const near = ENGAGEMENT_RANGE + 1;
    const far = ENEMY_INTENT_RENDEZVOUS_RANGE + 1;
    // 再会合の帯より遠くで近づいていても、まず再会合。
    assert.equal(nextEnemyIntent('departure', far, -10), 'rendezvous');
    assert.equal(nextEnemyIntent('rendezvous', far, -10), 'rendezvous');
    // 帯の内側へ入れば接近。
    assert.equal(nextEnemyIntent('rendezvous', near, -10), 'approach');
    // 離れていけば、どこでも再会合へ戻る。
    assert.equal(nextEnemyIntent('approach', near, 10), 'rendezvous');
    assert.equal(nextEnemyIntent('departure', near, 10), 'rendezvous');
    // 接近の途上で帯の外へ出ても、近づいている間は接近のまま。
    assert.equal(nextEnemyIntent('approach', far, -10), 'approach');
  });

  test('enemy-intent: 射撃できるのは射撃姿勢の間だけ', () => {
    assert.equal(enemyIntentAllowsFire('firing-posture'), true);
    assert.equal(enemyIntentAllowsFire('approach'), false);
    assert.equal(enemyIntentAllowsFire('departure'), false);
    assert.equal(enemyIntentAllowsFire('rendezvous'), false);
  });
}
