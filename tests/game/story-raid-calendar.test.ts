// 軌道暦の予定が、GAME.md 11.5 の襲撃の規則どおりに組まれることを検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  RAID_APPROACH_SECONDS, RAID_FORECAST_LEAD_SECONDS, RAID_INTERVAL_ORBITS,
  RAID_LINGER_SECONDS, nextRaidMilestoneAt, raidPhaseAt, raidPlanEntry,
} from '../../src/game/campaign/story-raid-calendar';

export function register(): void {
  test('story-raid-calendar: 襲撃は対象拠点の公転周期の整数倍の間隔で並ぶ', () => {
    // GAME.md 11.5: 襲撃の発生時刻は、対象拠点の公転周期の整数倍の間隔で並ぶ軌道暦で決まる。
    const period = 5400;
    const first = raidPlanEntry(0, 1000, period, 'base');
    const second = raidPlanEntry(1, 1000, period, 'base');
    assert.equal(first.arrivalAt, 1000 + period * RAID_INTERVAL_ORBITS);
    assert.equal(second.arrivalAt - first.arrivalAt, period * RAID_INTERVAL_ORBITS);
    assert.equal(first.targetBaseId, 'base');
  });

  test('story-raid-calendar: 予報は接近の24時間前に出て、編隊は接近の直前に現れ、留まった後に離脱する', () => {
    // GAME.md 11.5: 発生はゲーム内時間で24時間前から予報として表示される。
    assert.equal(RAID_FORECAST_LEAD_SECONDS, 24 * 3600);
    const entry = raidPlanEntry(0, 0, 5400, 'base');
    assert.equal(entry.forecastAt, entry.arrivalAt - RAID_FORECAST_LEAD_SECONDS);
    assert.equal(entry.spawnAt, entry.arrivalAt - RAID_APPROACH_SECONDS);
    assert.equal(entry.departAt, entry.arrivalAt + RAID_LINGER_SECONDS);
    assert.ok(entry.forecastAt < entry.spawnAt);
  });

  test('story-raid-calendar: 局面は予報→出現→接近→離脱の順に移る', () => {
    const entry = raidPlanEntry(0, 0, 5400, 'base');
    assert.equal(raidPhaseAt(entry, entry.forecastAt - 1), 'before-forecast');
    assert.equal(raidPhaseAt(entry, entry.forecastAt), 'forecast');
    assert.equal(raidPhaseAt(entry, entry.spawnAt), 'approach');
    assert.equal(raidPhaseAt(entry, entry.arrivalAt), 'present');
    assert.equal(raidPhaseAt(entry, entry.departAt), 'departed');
  });

  test('story-raid-calendar: 次の節目は時刻より後で最も早いもの', () => {
    const entry = raidPlanEntry(0, 0, 5400, 'base');
    assert.equal(nextRaidMilestoneAt(entry, entry.forecastAt - 1), entry.forecastAt);
    assert.equal(nextRaidMilestoneAt(entry, entry.forecastAt), entry.spawnAt);
    assert.equal(nextRaidMilestoneAt(entry, entry.spawnAt), entry.departAt);
    assert.equal(nextRaidMilestoneAt(entry, entry.departAt), null);
  });
}
