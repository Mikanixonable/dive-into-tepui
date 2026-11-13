// 波状攻撃の難関・息抜きの周期(stage-utils/wave-attack.ts の waveShape)、ブリーフィングの予告の一行、
// 結果画面の要約(stage.ts の summaryHtml)の回帰テスト。機数の式そのものは固定せず、
// 周期・難関と息抜きの関係・上限だけを見る。
import * as assert from 'node:assert/strict';
import { waveShape, waveForecastLine } from '../../src/game/stages/stage-utils/wave-attack';
import { summaryHtml, missionTimeText } from '../../src/game/stages/stage';
import { test } from '../harness';

export function register(): void {
  test('wave-schedule: 3 の倍数の波だけが難関になる', () => {
    for (let n = 1; n <= 12; n++) {
      assert.equal(waveShape(n).boss, n % 3 === 0, `第${n}波の難関の有無が周期と合わない`);
    }
  });

  test('wave-schedule: 難関の直後の波は息抜きで、通常より機数が少ない', () => {
    for (const n of [4, 7, 10]) {
      const rest = waveShape(n);
      assert.equal(rest.rest, true, `第${n}波が息抜きになっていない`);
      // 通常の機数(上限 30 まで)の半分を切り上げた数になる。
      const normal = Math.min(5 + 2 * (n - 1), 30);
      assert.equal(rest.ships, Math.ceil(normal / 2), `第${n}波の機数が通常の半分(切り上げ)になっていない`);
    }
  });

  test('wave-schedule: 第1波は息抜きにも難関にもならない', () => {
    const first = waveShape(1);
    assert.equal(first.boss, false);
    assert.equal(first.rest, false);
  });

  test('wave-schedule: 機数は上限を超えない', () => {
    for (let n = 1; n <= 40; n++) {
      assert.ok(waveShape(n).ships <= 30, `第${n}波の機数が上限 30 を超えている`);
    }
  });

  test('wave-schedule: 予告の一行は第1波だけ後方からと書く', () => {
    assert.ok(waveForecastLine(1).includes('後方から'), '第1波の予告に後方が無い');
    assert.ok(!waveForecastLine(2).includes('後方から'), '第2波の予告に後方が付いている');
    assert.ok(waveForecastLine(3).includes('難関'), '第3波の予告に難関が無い');
  });

  test('wave-schedule: 結果の要約は撃破率・撃破あたりの発射弾数・生存時間を出す', () => {
    const html = summaryHtml({ kills: 3, appeared: 4, shots: 30, hits: 15, survivalSec: 75 });
    assert.ok(html.includes('撃破率 75%'), `撃破率が違う: ${html}`);
    assert.ok(html.includes('撃破あたり 10.0 発'), `撃破あたりの弾数が違う: ${html}`);
    assert.ok(html.includes(`生存時間 T+ ${missionTimeText(75)}`), `生存時間が違う: ${html}`);
  });

  test('wave-schedule: 撃破が 0 のとき撃破あたりの弾数は出さない', () => {
    const html = summaryHtml({ kills: 0, appeared: 2, shots: 5, hits: 1, survivalSec: 10 });
    assert.ok(html.includes('撃破あたり — 発'), `撃破 0 の表示が違う: ${html}`);
  });
}
