// 撃墜・自機喪失の止め(SPEC COMBAT.md「撃墜の止め」)の回帰テスト。発火条件・倍率と長さ・
// 重なり・除外条件(ワープ・ポーズ・建造)を確かめる。
import * as assert from 'node:assert/strict';
import { KillStop } from '../../src/game/kill-stop';
import { kinematicState } from '../../src/physics/kinematic-state';
import { v3 } from '../../src/math/vec3';
import type { RunEvent } from '../../src/game/run-events';
import { test } from '../harness';

const state = kinematicState<'eci'>(0, v3(), v3());
const ENEMY_KILL: RunEvent = { seq: 0, body: { kind: 'enemyDied', name: 'e', cause: 'killed' } };
const ENEMY_COLLISION: RunEvent = { seq: 0, body: { kind: 'enemyDied', name: 'e', cause: 'collision' } };
const ENEMY_BURNUP: RunEvent = { seq: 0, body: { kind: 'enemyDied', name: 'e', cause: 'burnup' } };
const PLAYER_EXPLODED: RunEvent = { seq: 0, body: { kind: 'shipExploded', state, modelScale: 1, owner: 'player' } };
const ENEMY_EXPLODED: RunEvent = { seq: 0, body: { kind: 'shipExploded', state, modelScale: 1, owner: 'enemy' } };

function observe(stop: KillStop, events: readonly RunEvent[]): void {
  stop.observe(events, 1, false, false);
}

export function register(): void {
  test('kill stop: enemy kill slows the world clock to 0.2 for 0.25 s then returns to 1', () => {
    const stop = new KillStop();
    assert.equal(stop.worldTimeScale, 1);
    observe(stop, [ENEMY_KILL]);
    assert.equal(stop.worldTimeScale, 0.2);
    stop.advance(0.1);
    assert.equal(stop.worldTimeScale, 0.2);
    stop.advance(0.1);
    // 残り 30% (0.075 s) の区間で等倍へ戻る — 途中の倍率は floor と 1 の間。
    const mid = stop.worldTimeScale;
    assert.ok(mid > 0.2 && mid < 1, `expected easing scale, got ${mid}`);
    stop.advance(0.05);
    assert.equal(stop.worldTimeScale, 1);
  });

  test('kill stop: player loss slows to 0.1 for 0.6 s', () => {
    const stop = new KillStop();
    observe(stop, [PLAYER_EXPLODED]);
    assert.equal(stop.worldTimeScale, 0.1);
    stop.advance(0.6);
    assert.equal(stop.worldTimeScale, 1);
  });

  test('kill stop: burnup/despawn deaths and enemy explosions do not trigger', () => {
    const stop = new KillStop();
    observe(stop, [
      ENEMY_BURNUP, { seq: 0, body: { kind: 'enemyDied', name: 'e', cause: 'despawn' } },
      ENEMY_EXPLODED,
    ]);
    assert.equal(stop.worldTimeScale, 1);
    observe(stop, [ENEMY_COLLISION]);
    assert.equal(stop.worldTimeScale, 0.2);
  });

  test('kill stop: does not engage during warp, pause, or construction', () => {
    const stop = new KillStop();
    stop.observe([ENEMY_KILL, PLAYER_EXPLODED], 10, false, false);
    assert.equal(stop.worldTimeScale, 1);
    stop.observe([ENEMY_KILL, PLAYER_EXPLODED], 1, true, false);
    assert.equal(stop.worldTimeScale, 1);
    stop.observe([ENEMY_KILL, PLAYER_EXPLODED], 1, false, true);
    assert.equal(stop.worldTimeScale, 1);
  });

  test('kill stop: overlapping events keep the longer remainder instead of stacking', () => {
    const stop = new KillStop();
    // 撃破の止めの途中に自機喪失 — 残りの長い 0.6 s へ揃える。
    observe(stop, [ENEMY_KILL]);
    stop.advance(0.1);
    observe(stop, [PLAYER_EXPLODED]);
    assert.equal(stop.worldTimeScale, 0.1);
    stop.advance(0.6);
    assert.equal(stop.worldTimeScale, 1);

    // 逆に自機喪失の最中の撃破は短いので無視する。
    observe(stop, [PLAYER_EXPLODED]);
    stop.advance(0.1);
    observe(stop, [ENEMY_KILL]);
    assert.equal(stop.worldTimeScale, 0.1);

    // 撃破の連続は足さず残りを 0.25 s へ立て直す。
    const stop2 = new KillStop();
    observe(stop2, [ENEMY_KILL]);
    stop2.advance(0.1);
    observe(stop2, [ENEMY_KILL]);
    assert.equal(stop2.worldTimeScale, 0.2);
    stop2.advance(0.25);
    assert.equal(stop2.worldTimeScale, 1);
  });
}
