// 影の源の選定(render/pipeline/shadow/shadow-select.ts)のうち、雲の影の設定読み分けの回帰テスト。
// 雲の影 × 積雲の精細さの組ごとに、積雲と巻雲どちらの影が落ちるかを見る。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { cloudShadowKinds, type CloudShadowKinds } from '../../src/render/pipeline/shadow/shadow-select';
import { DEFAULT_GRAPHICS, withGraphicsOption } from '../../src/render/graphics-settings';

// 雲・雲の影・各種類の表示設定から、種類ごとの影の有無を確認する。
const CASES: readonly {
  readonly clouds: boolean;
  readonly cloudShadow: boolean;
  readonly cumulus: boolean;
  readonly cirrus: boolean;
  readonly expected: Pick<CloudShadowKinds, 'cumulus' | 'cirrus'>;
}[] = [
  { clouds: true, cloudShadow: true, cumulus: true, cirrus: true, expected: { cumulus: true, cirrus: true } },
  { clouds: true, cloudShadow: true, cumulus: false, cirrus: true, expected: { cumulus: false, cirrus: true } },
  { clouds: true, cloudShadow: true, cumulus: true, cirrus: false, expected: { cumulus: true, cirrus: false } },
  { clouds: true, cloudShadow: true, cumulus: false, cirrus: false, expected: { cumulus: false, cirrus: false } },
  { clouds: true, cloudShadow: false, cumulus: true, cirrus: true, expected: { cumulus: false, cirrus: false } },
  { clouds: false, cloudShadow: true, cumulus: true, cirrus: true, expected: { cumulus: false, cirrus: false } },
];

export function register(): void {
  for (const c of CASES) {
    const label = `雲=${onOff(c.clouds)} 雲の影=${onOff(c.cloudShadow)}`
      + ` 積雲=${onOff(c.cumulus)} 巻雲=${onOff(c.cirrus)}`;
    test(`shadow-select: 雲の影の種類ごとの有無(${label})`, () => {
      const graphics = withGraphicsOption(
        withGraphicsOption(
          withGraphicsOption(
            withGraphicsOption(DEFAULT_GRAPHICS, 'clouds', c.clouds),
            'cloudShadow', c.cloudShadow),
          'cumulus', c.cumulus),
        'cirrus', c.cirrus);
      const kinds = cloudShadowKinds(graphics);
      assert.deepEqual({ cumulus: kinds.cumulus, cirrus: kinds.cirrus }, c.expected);
      assert.equal(kinds.cumulusOctaves, 6);
      assert.equal(kinds.cirrusOctaves, 4);
    });
  }
}

function onOff(value: boolean): string {
  return value ? 'オン' : 'オフ';
}
