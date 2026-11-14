// ステージごとのベストと連敗(launcher/stage-records.ts)の回帰テスト。SPEC GAME.md 6「ベスト」と
// 「連敗の予告」の規則を見る。ブラウザの保存は無い環境でも、記録は周回の中で一貫することを見る。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { StageRecords, FORECAST_LOSS_STREAK, bestDetailHtml } from '../../src/launcher/stage-records';
import type { RunStats } from '../../src/game/stages/stage';

// 検査が使う kills/survivalSec だけ指定した成績。残りの項目はどの検査でも読まない固定値。
function stats(kills: number, survivalSec: number): RunStats {
  return { kills, appeared: 10, shots: 40, hits: 20, survivalSec };
}

export function register(): void {
  test('stage-records: 初めての記録はベストが無く、どちらも上回った扱いになる', () => {
    const records = new StageRecords({}, () => {});
    const cmp = records.compare('00', stats(2, 100));
    assert.equal(cmp.survival.best, null);
    assert.equal(cmp.survival.beaten, true);
    assert.equal(cmp.kills.best, null);
    assert.equal(cmp.kills.beaten, true);
  });

  test('stage-records: ベストは上回ったときだけ置き換わり、下回った記録では変わらない', () => {
    const records = new StageRecords({}, () => {});
    records.record('00', 'lost', stats(5, 300));
    const lower = records.compare('00', stats(3, 200));
    assert.equal(lower.survival.best, 300);
    assert.equal(lower.survival.beaten, false);
    assert.equal(lower.kills.best, 5);
    assert.equal(lower.kills.beaten, false);

    records.record('00', 'lost', stats(3, 200));
    assert.equal(records.compare('00', stats(0, 0)).survival.best, 300, '下回った記録で最長が縮んだ');
    assert.equal(records.compare('00', stats(0, 0)).kills.best, 5, '下回った記録で最多が縮んだ');
  });

  test('stage-records: 連敗は敗北で 1 増え、勝利とタイムアップで止まる', () => {
    const records = new StageRecords({}, () => {});
    records.record('00', 'lost', stats(1, 10));
    records.record('00', 'lost', stats(1, 10));
    assert.equal(records.lossStreak('00'), 2);
    assert.ok(records.lossStreak('00') >= FORECAST_LOSS_STREAK, '2 連敗で予告の条件に届かない');

    records.record('00', 'won', stats(1, 10));
    assert.equal(records.lossStreak('00'), 0, '勝利で連敗が止まっていない');
    records.record('00', 'lost', stats(1, 10));
    records.record('00', 'timeup', stats(1, 10));
    assert.equal(records.lossStreak('00'), 0, 'タイムアップで連敗が止まっていない');
  });

  test('stage-records: ステージごとに別々に数える', () => {
    const records = new StageRecords({}, () => {});
    records.record('1', 'lost', stats(1, 10));
    assert.equal(records.lossStreak('1'), 1);
    assert.equal(records.lossStreak('00'), 0);
    assert.equal(records.compare('00', stats(0, 0)).survival.best, null, '別のステージの記録が混ざった');
  });

  test('stage-records: 結果画面のベストの行は、更新と未達を区別する', () => {
    const records = new StageRecords({}, () => {});
    records.record('00', 'lost', stats(5, 300));
    const beaten = bestDetailHtml(stats(6, 400), records.compare('00', stats(6, 400)));
    assert.ok(beaten.includes('ベスト更新'), `上回ったのに更新と出ない: ${beaten}`);

    const short = bestDetailHtml(stats(3, 200), records.compare('00', stats(3, 200)));
    assert.ok(short.includes('ベストまであと 2 機'), `撃破の差が出ない: ${short}`);
  });
}
