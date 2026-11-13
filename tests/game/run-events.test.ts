// 直近の進行で起きた出来事の記録と、それを告知へ写す表示の導出が、同じ出来事を二度扱わないことを
// 検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { RunEventLog } from '../../src/game/run-events';
import { RunEventPresenter } from '../../src/game/run-event-presenter';
import { UiSoundQueue } from '../../src/game/ui-sound-queue';
import type { Notifier } from '../../src/hud/notifier';

// 出した告知を順に溜める Notifier と、その本文。
function recordingNotifier(): { notifier: Notifier; shown: string[] } {
  const shown: string[] = [];
  return { notifier: { hint: (text) => shown.push(text), toast: (html) => shown.push(html) }, shown };
}

export function register(): void {
  test('run-events: beginStep で直近の記録は空になり、通し番号はその後も続く', () => {
    // ARCHITECTURE R7: 出来事は通し番号を持ち、記録は進行の位相の先頭で空にする
    const log = new RunEventLog();
    log.record({ kind: 'autoWarpStarted' });
    log.record({ kind: 'autoWarpCancelled' });
    const earlier = log.recent.map((event) => event.seq);
    assert.ok(earlier[0] < earlier[1]);

    log.beginStep();
    assert.equal(log.recent.length, 0);
    log.record({ kind: 'autoWarpStarted' });
    const later = log.recent.map((event) => event.seq);
    assert.equal(later.length, 1);
    assert.ok(earlier.every((seq) => seq < later[0]));
  });

  test('run-event-presenter: 同じ通し番号の出来事は、何度渡されても1度だけ写す', () => {
    // ARCHITECTURE R7: 同じ通し番号を二度扱わない
    const { notifier, shown } = recordingNotifier();
    const presenter = new RunEventPresenter(new UiSoundQueue(), notifier);
    const log = new RunEventLog();
    log.record({ kind: 'autoWarpStarted' });
    presenter.present(log.recent);
    presenter.present(log.recent);
    assert.equal(shown.length, 1);

    log.beginStep();
    log.record({ kind: 'autoWarpCancelled' });
    presenter.present(log.recent);
    assert.equal(shown.length, 2);
  });

  test('鹵獲: 授与は通知音を鳴らし、告知は授与の 0.5 秒後に出る', async () => {
    // SPEC GAME.md 3.1: 告知は撃墜の演出と重ならないよう、授与から 0.5 秒遅らせる。
    const { notifier, shown } = recordingNotifier();
    const sounds = new UiSoundQueue();
    const presenter = new RunEventPresenter(sounds, notifier);
    const log = new RunEventLog();
    log.record({ kind: 'salvageAwarded', name: '鹵獲: 砲座' });
    presenter.present(log.recent);

    assert.deepEqual(sounds.cues.map((cue) => cue.sound), ['salvage-award']);
    assert.equal(shown.length, 0);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(shown.filter((text) => text.includes('鹵獲: 砲座 を授与')).length, 1);
  });
}
