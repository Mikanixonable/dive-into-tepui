// 直近の進行で起きた出来事の記録と、それを告知へ写す表示の導出が、同じ出来事を二度扱わないことを
// 検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { RunEventLog } from '../../src/game/run-events';
import { RunEventPresenter } from '../../src/game/run-event-presenter';
import type { Notifier } from '../../src/hud/notifier';
import type { UiSfx } from '../../src/audio/sfx/ui-sfx';
import type { WorldSfx } from '../../src/audio/sfx/world-sfx';

// 出した告知を順に溜める Notifier と、その本文。
function recordingNotifier(): { notifier: Notifier; shown: string[] } {
  const shown: string[] = [];
  return { notifier: { hint: (text) => shown.push(text), toast: (html) => shown.push(html) }, shown };
}

export function register(): void {
  test('run-events: beginStep で直近の記録は空になり、通し番号はその後も続く', () => {
    // CODING-RULE R7: 出来事は通し番号を持ち、記録は進行の位相の先頭で空にする
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
    // CODING-RULE R7: 同じ通し番号を二度扱わない
    const { notifier, shown } = recordingNotifier();
    // 写す出来事は告知だけを伴う種別に限るので、音の装置(組むには DOM が要る)は呼ばれない。
    const presenter = new RunEventPresenter({} as WorldSfx, {} as UiSfx, notifier);
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
}
