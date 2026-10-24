import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  PAST_REGION_MAX_FRACTION, PAST_REGION_MIN_FRACTION,
  buildTicks, fmtOffsetLabel, fmtSpanLabel, pastRegionFraction,
} from '../../src/game/hud/orbit/tick-scale';
import { DisplayTimelineEvents } from '../../src/game/map/display-timeline-events';
import type { TimelineEvent } from '../../src/game/map/timeline-event';
import type { PlanDisplay } from '../../src/game/plan/plan-display';
import type { EquatorNodeManager } from '../../src/game/marker/equator-node-manager';
import type { NavTargetPresenter } from '../../src/game/nav-target-presenter';
import type { ControlSelection } from '../../src/game/control-selection';

const DAY = 86400;
const MAX_TICKS = 6;

// 時間軸の目盛り(軸のラベル・過去の帯の割り当て・読み値の表記)と、軸へ載せる事象の並びの回帰テスト。
export function register(): void {
  test('timeline ticks: without a past span they are the plain [0, duration] ticks', () => {
    const ticks = buildTicks(DAY, MAX_TICKS);
    assert.deepEqual(ticks.map((tick) => tick.label), ['T+0', 'T+6h', 'T+12h', 'T+18h', 'T+24h']);
    assert.deepEqual(ticks.map((tick) => tick.t), [0, 0.25, 0.5, 0.75, 1]);
    assert.deepEqual(buildTicks(DAY, MAX_TICKS, 0), ticks);
    assert.deepEqual(buildTicks(0, MAX_TICKS), []);
    assert.deepEqual(buildTicks(Number.POSITIVE_INFINITY, MAX_TICKS), []);
    assert.deepEqual(buildTicks(DAY, MAX_TICKS, Number.NaN), []);
  });

  test('timeline ticks: with a past span there are at most 6, ordered within [0, 1], negatives labelled T-', () => {
    const durations = [5400, 3600, DAY, 10 * DAY, 90 * DAY, 365 * DAY];
    const pasts = [3600, DAY, 10 * DAY, 30 * DAY, 90 * DAY, 365 * DAY];
    for (const duration of durations) {
      for (const past of pasts) {
        const ticks = buildTicks(duration, MAX_TICKS, past);
        const fraction = pastRegionFraction(past, duration);
        const where = `duration=${duration} past=${past}`;
        assert.ok(ticks.length <= MAX_TICKS && ticks.length > 0, where);
        for (const tick of ticks) {
          assert.ok(tick.t >= 0 && tick.t <= 1, `${where} t=${tick.t}`);
          // 過去の目盛りは過去の帯の中、未来の目盛りは帯の右に置く。
          if (tick.label.startsWith('T-')) assert.ok(tick.t < fraction, `${where} ${tick.label}`);
          else assert.ok(tick.t >= fraction, `${where} ${tick.label}`);
        }
        for (let i = 1; i < ticks.length; i++) assert.ok((ticks[i]?.t ?? 0) > (ticks[i - 1]?.t ?? 0), where);
        // 現在の目盛りは過去の帯の終端、未来の終端は右端。
        const now = ticks.find((tick) => tick.label === 'T+0');
        assert.ok(now !== undefined && Math.abs(now.t - fraction) < 1e-12, where);
        assert.ok(ticks.some((tick) => tick.label.startsWith('T-')), where);
      }
    }
  });

  test('past region: absent without a past, proportional in between, and clamped so the future keeps most of the track', () => {
    assert.equal(pastRegionFraction(0, DAY), 0);
    assert.equal(pastRegionFraction(-1, DAY), 0);
    assert.equal(pastRegionFraction(DAY, 0), 0);
    assert.equal(pastRegionFraction(Number.NaN, DAY), 0);
    // 過去1日・未来1周(約1.5h)でも、未来側は幅の 80% 以上を保つ。
    assert.equal(pastRegionFraction(DAY, 5400), PAST_REGION_MAX_FRACTION);
    assert.equal(pastRegionFraction(90 * DAY, 90 * DAY), PAST_REGION_MAX_FRACTION);
    assert.equal(pastRegionFraction(3600, 365 * DAY), PAST_REGION_MIN_FRACTION);
    assert.ok(Math.abs(pastRegionFraction(DAY, 7 * DAY) - 0.125) < 1e-12);
    for (const past of [3600, DAY, 90 * DAY, 365 * DAY]) {
      for (const duration of [3600, DAY, 365 * DAY]) {
        const fraction = pastRegionFraction(past, duration);
        assert.ok(fraction >= PAST_REGION_MIN_FRACTION && fraction <= PAST_REGION_MAX_FRACTION);
      }
    }
  });

  test('timeline labels: offsets keep their sign and round to two units', () => {
    assert.equal(fmtOffsetLabel(0), 'T+0s');
    assert.equal(fmtOffsetLabel(59), 'T+59s');
    assert.equal(fmtOffsetLabel(75), 'T+1m 15s');
    assert.equal(fmtOffsetLabel(4440), 'T+1h 14m');
    assert.equal(fmtOffsetLabel(DAY + 3600), 'T+1d 1h');
    assert.equal(fmtOffsetLabel(-7500), 'T-2h 5m');
    assert.equal(fmtOffsetLabel(-0.2), 'T+0s');
    assert.equal(fmtOffsetLabel(Number.NaN), 'T+--');
  });

  test('timeline labels: span unit changes at 1 day, 30 days and 365 days', () => {
    assert.equal(fmtSpanLabel(3600), '1時間');
    assert.equal(fmtSpanLabel(5400), '1.5時間');
    assert.equal(fmtSpanLabel(DAY - 3600), '23時間');
    assert.equal(fmtSpanLabel(DAY), '1日');
    assert.equal(fmtSpanLabel(10 * DAY), '10日');
    assert.equal(fmtSpanLabel(30 * DAY - DAY), '29日');
    assert.equal(fmtSpanLabel(30 * DAY), '1ヶ月');
    assert.equal(fmtSpanLabel(90 * DAY), '3ヶ月');
    assert.equal(fmtSpanLabel(365 * DAY - DAY), '12.13ヶ月');
    assert.equal(fmtSpanLabel(365 * DAY), '1年');
  });

  test('timeline events: gathered from every source and returned in time order', () => {
    const push = (...events: TimelineEvent[]) => ({
      pushTimelineEvents: (out: TimelineEvent[]) => { out.push(...events); },
    });
    const plan = push({ kind: 'maneuverNode', time: 300, name: 'N1' });
    const equator = {
      seen: '' as string,
      pushTimelineEvents(out: TimelineEvent[], id: string) {
        this.seen = id;
        out.push({ kind: 'ascendingNode', time: 100, name: 'AN' });
      },
    };
    const target = push({ kind: 'closestApproach', time: 200, name: 'CA' });
    const events = new DisplayTimelineEvents(
      plan as unknown as PlanDisplay, equator as unknown as EquatorNodeManager,
      target as unknown as NavTargetPresenter, { current: { id: 'ship-1' } } as unknown as ControlSelection,
    );
    assert.deepEqual(events.current().map((event) => event.name), ['AN', 'CA', 'N1']);
    assert.equal(equator.seen, 'ship-1');
    // 次の呼び出しは前回の中身を引き継がない。
    assert.equal(events.current().length, 3);
  });

  test('timeline events: without a controlled entity the equator nodes are left out', () => {
    const none = { pushTimelineEvents: (_out: TimelineEvent[]) => undefined };
    const equator = {
      pushTimelineEvents(out: TimelineEvent[]) { out.push({ kind: 'ascendingNode', time: 1, name: 'AN' }); },
    };
    const events = new DisplayTimelineEvents(
      none as unknown as PlanDisplay, equator as unknown as EquatorNodeManager,
      none as unknown as NavTargetPresenter, { current: null } as unknown as ControlSelection,
    );
    assert.deepEqual(events.current(), []);
  });
}
