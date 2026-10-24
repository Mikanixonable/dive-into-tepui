import * as assert from 'node:assert/strict';
import { BRIEFING_VISIBLE_MS, BriefingClock } from '../../src/game/hud/briefing-clock';
import { test } from '../harness';

// ブリーフィングのカードを畳む勘定: 表示の始まりは出した次の同期の実時刻で確定し、
// 時間・警報のどちらかで畳む。
export function register(): void {
  test('briefing clock: the shown time is fixed at the first update after show, not at show', () => {
    const clock = new BriefingClock();
    clock.show();
    // show した時点の時刻は持たない: 始まりは次の update の時刻になる。読み込み中の同期(時刻 0)から
    // 数えさせないため、Run が最初の通常のフレームまで show を遅らせる。
    assert.equal(clock.update(false, 20_000), false);
    assert.equal(clock.update(false, 20_000 + BRIEFING_VISIBLE_MS), false);
    assert.equal(clock.update(false, 20_000 + BRIEFING_VISIBLE_MS + 1), true);
  });

  test('briefing clock: an alarm folds it at once and a fold ends the clock', () => {
    const clock = new BriefingClock();
    clock.show();
    assert.equal(clock.update(true, 100), true);
    // 畳んだ後は何度同期しても畳み直さない。
    assert.equal(clock.update(true, 200), false);
    assert.equal(clock.update(false, 100_000), false);
  });

  test('briefing clock: nothing is folded while it has not been shown', () => {
    const clock = new BriefingClock();
    assert.equal(clock.update(true, 100_000), false);
    clock.show();
    clock.fold();
    assert.equal(clock.update(false, 100_000), false);
  });

  test('briefing clock: showing again restarts the time from the next update', () => {
    const clock = new BriefingClock();
    clock.show();
    clock.update(false, 1000);
    clock.show();
    assert.equal(clock.update(false, 1000 + BRIEFING_VISIBLE_MS + 5000), false);
    assert.equal(clock.update(false, 1000 + 2 * BRIEFING_VISIBLE_MS + 6000), true);
  });
}
