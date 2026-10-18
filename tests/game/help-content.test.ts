import * as assert from 'node:assert/strict';
import { helpRowGroups, helpRows, type HelpCategory } from '../../src/game/hud/windows/help-content';
import { test } from '../harness';

const CATEGORIES: readonly HelpCategory[] = ['flight', 'camera', 'combat', 'map', 'system'];

// ヘルプの対応表が、タッチ・マウスの行とキーボードの行へ漏れなく分かれることを確かめる(UI-DESIGN §8「ヘルプ」)。
export function register(): void {
  test('help content: every row lands in exactly one of the gesture and key groups', () => {
    const grouped = CATEGORIES.flatMap((category) => {
      const { gestures, keys } = helpRowGroups(category);
      return [...gestures, ...keys];
    });
    assert.equal(grouped.length, helpRows().length);
    for (const category of CATEGORIES) {
      const { gestures, keys } = helpRowGroups(category);
      assert.ok(gestures.every((row) => row.input.kind === 'gesture' && row.input.chips.length > 0));
      assert.ok(keys.every((row) => row.input.kind === 'key' && row.input.keys.length > 0));
    }
  });

  test('help content: the touch gestures named by the spec are all reachable from the table', () => {
    const chips = CATEGORIES.flatMap((category) => helpRowGroups(category).gestures)
      .flatMap((row) => (row.input.kind === 'gesture' ? row.input.chips : []));
    for (const gesture of ['長押し', '二本指ドラッグ', 'ピンチ', 'ダブルタップ']) {
      assert.ok(chips.includes(gesture), `${gesture} is missing from the help table`);
    }
  });
}
