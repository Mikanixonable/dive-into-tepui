// 影の源の選定(render/pipeline/shadow/shadow-select.ts)のうち、雲の影の設定読み分けの回帰テスト。
// 雲の影 × 巻雲 × 積雲の精細さの組ごとに、積雲と巻雲どちらの影が落ちるかを見る。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { cloudShadowKinds, type CloudShadowKinds } from '../../src/render/pipeline/shadow/shadow-select';
import { DEFAULT_GRAPHICS, withGraphicsOption } from '../../src/render/graphics-settings';
import { CUMULUS_DETAIL } from '../../src/render/opaque-cloud-surface-renderer';

// (雲, 雲の影, 巻雲, 積雲の精細さがオフか) から種類ごとの影の有無への対応表。
// 積雲の影は積雲の立体を描くときだけ、巻雲の影は巻雲を描くときだけ落ちる。
const CASES: readonly {
  readonly clouds: boolean;
  readonly cloudShadow: boolean;
  readonly cirrus: boolean;
  readonly cumulusOff: boolean;
  readonly expected: CloudShadowKinds;
}[] = [
  { clouds: true, cloudShadow: true, cirrus: true, cumulusOff: false, expected: { cumulus: true, cirrus: true } },
  { clouds: true, cloudShadow: true, cirrus: true, cumulusOff: true, expected: { cumulus: false, cirrus: true } },
  { clouds: true, cloudShadow: true, cirrus: false, cumulusOff: false, expected: { cumulus: true, cirrus: false } },
  { clouds: true, cloudShadow: true, cirrus: false, cumulusOff: true, expected: { cumulus: false, cirrus: false } },
  { clouds: true, cloudShadow: false, cirrus: true, cumulusOff: false, expected: { cumulus: false, cirrus: false } },
  { clouds: true, cloudShadow: false, cirrus: true, cumulusOff: true, expected: { cumulus: false, cirrus: false } },
  { clouds: true, cloudShadow: false, cirrus: false, cumulusOff: false, expected: { cumulus: false, cirrus: false } },
  { clouds: true, cloudShadow: false, cirrus: false, cumulusOff: true, expected: { cumulus: false, cirrus: false } },
  { clouds: false, cloudShadow: true, cirrus: true, cumulusOff: false, expected: { cumulus: false, cirrus: false } },
];

export function register(): void {
  for (const c of CASES) {
    const label = `雲=${onOff(c.clouds)} 雲の影=${onOff(c.cloudShadow)} 巻雲=${onOff(c.cirrus)}`
      + ` 積雲の精細さ=${c.cumulusOff ? 'オフ' : '標準'}`;
    test(`shadow-select: 雲の影の種類ごとの有無(${label})`, () => {
      const graphics = withGraphicsOption(
        withGraphicsOption(
          withGraphicsOption(
            withGraphicsOption(DEFAULT_GRAPHICS, 'clouds', c.clouds),
            'cloudShadow', c.cloudShadow),
          'cirrus', c.cirrus),
        'cumulusDetail', c.cumulusOff ? CUMULUS_DETAIL.off : CUMULUS_DETAIL.standard);
      assert.deepEqual(cloudShadowKinds(graphics), c.expected);
    });
  }
}

function onOff(value: boolean): string {
  return value ? 'オン' : 'オフ';
}
