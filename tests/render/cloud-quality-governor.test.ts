// 雲の品質適応(render/earth-weather/cloud/cloud-quality-governor.ts)の回帰テスト。
// フットプリント上限の閾値(直下点の画素の実寸で解像できる段)と、予算上限の状態機械
// (連続超過で下げ・余裕で戻す・冷却で往復を抑える)を見る。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  CloudQualityGovernor, DETAIL_TIERS, footprintLevel,
} from '../../src/render/earth-weather/cloud/cloud-quality-governor';
import { DETAIL_WAVELENGTHS } from '../../src/render/earth-weather/cloud/cloud-detail';

const CUMULUS_TIER_OCTAVES = [4, 6, 8] as const;
const CIRRUS_TIER_OCTAVES = [0, 4, 6] as const;
const CIRRUS_WAVELENGTHS = DETAIL_WAVELENGTHS.slice(2);

// 1フレームぶんの update を、同じ条件で frames 回数ぶん流す。
function frames(
  governor: CloudQualityGovernor, count: number, frameMs: number, cloudGpuMs: number | null,
  active = true,
): void {
  for (let i = 0; i < count; i++) governor.update(frameMs, cloudGpuMs, active);
}

export function register(): void {
  test('cloud-quality: フレームレート上限で待つ時間は超過と見なさない', () => {
    // 上限 30 fps の 33.4ms 間隔で雲が 8.7ms(占有 26%)— 上限なしなら枠超過で下がるが、
    // 上限の間隔の内なら下げない。
    const capped = new CloudQualityGovernor();
    for (let i = 0; i < 100; i++) capped.update(33.4, 8.7, true, 30);
    assert.equal(capped.levelCap, DETAIL_TIERS - 1);
    const uncapped = new CloudQualityGovernor();
    for (let i = 0; i < 100; i++) uncapped.update(33.4, 8.7, true, 0);
    assert.ok(uncapped.levelCap < DETAIL_TIERS - 1);
  });

  test('cloud-quality: フットプリント上限 — 積雲', () => {
    // spanMin=0(直下)では全段が解像できて精細、2km では 2km 以下の段が消えて粗、
    // 300m では 500/250m の段が消えて標準、200m では 250m だけが消えて精細。
    assert.equal(footprintLevel(0, CUMULUS_TIER_OCTAVES, DETAIL_WAVELENGTHS), 2);
    assert.equal(footprintLevel(200, CUMULUS_TIER_OCTAVES, DETAIL_WAVELENGTHS), 2);
    assert.equal(footprintLevel(300, CUMULUS_TIER_OCTAVES, DETAIL_WAVELENGTHS), 1);
    assert.equal(footprintLevel(2000, CUMULUS_TIER_OCTAVES, DETAIL_WAVELENGTHS), 0);
  });

  test('cloud-quality: フットプリント上限 — 巻雲', () => {
    // 巻雲は 32・16km の段を持たない。5km では 8km 以下の全段が消えて粗、
    // 300m では 500/250m が消えて標準、100m では全段が解像できて精細。
    assert.equal(footprintLevel(5000, CIRRUS_TIER_OCTAVES, CIRRUS_WAVELENGTHS), 0);
    assert.equal(footprintLevel(300, CIRRUS_TIER_OCTAVES, CIRRUS_WAVELENGTHS), 1);
    assert.equal(footprintLevel(100, CIRRUS_TIER_OCTAVES, CIRRUS_WAVELENGTHS), 2);
  });

  test('cloud-quality: 予算上限 — 雲が枠を占有して続くと段を下げる', () => {
    const governor = new CloudQualityGovernor();
    assert.equal(governor.levelCap, DETAIL_TIERS - 1);
    // 20ms 枠超過で雲 6ms(30%) が 0.5s 続くと 1 段下がる。
    frames(governor, 24, 20, 6);
    assert.equal(governor.levelCap, DETAIL_TIERS - 1);
    frames(governor, 2, 20, 6);
    assert.equal(governor.levelCap, 1);
  });

  test('cloud-quality: 予算上限 — 雲の占有が小さい枠超過では下げない', () => {
    const governor = new CloudQualityGovernor();
    // 枠を超えても雲が 25% 未満なら雲以外が原因なので段は据え置き。
    frames(governor, 100, 20, 4);
    assert.equal(governor.levelCap, DETAIL_TIERS - 1);
  });

  test('cloud-quality: 予算上限 — 散発する遅れでは下げない', () => {
    const governor = new CloudQualityGovernor();
    // 枠超過と枠内が交互では連続超過に数えない。
    for (let i = 0; i < 100; i++) governor.update(i % 2 === 0 ? 20 : 10, 6, true);
    assert.equal(governor.levelCap, DETAIL_TIERS - 1);
  });

  test('cloud-quality: 予算上限 — 冷却中は連続して下げない', () => {
    const governor = new CloudQualityGovernor();
    frames(governor, 26, 20, 6);
    assert.equal(governor.levelCap, 1);
    // 冷却 2s の間は超過が続いても 2 段目は下がらない。
    frames(governor, 60, 20, 6);
    assert.equal(governor.levelCap, 1);
    // 冷却後に超過が続けば次の段へ下がる。
    frames(governor, 40, 20, 6);
    assert.equal(governor.levelCap, 0);
  });

  test('cloud-quality: 予算上限 — 余裕が続くと段を戻す', () => {
    const governor = new CloudQualityGovernor();
    frames(governor, 26, 20, 6);
    assert.equal(governor.levelCap, 1);
    // 10ms の余裕フレームが 5s 続くと 1 段戻る。
    frames(governor, 500, 10, 2);
    assert.equal(governor.levelCap, 2);
  });

  test('cloud-quality: 予算上限 — 時刻印が取れない環境では働かない', () => {
    const governor = new CloudQualityGovernor();
    frames(governor, 200, 20, null);
    assert.equal(governor.levelCap, DETAIL_TIERS - 1);
  });

  test('cloud-quality: 予算上限 — 非アクティブの間は窓を進めない', () => {
    const governor = new CloudQualityGovernor();
    frames(governor, 200, 20, 6, false);
    assert.equal(governor.levelCap, DETAIL_TIERS - 1);
    // 止まっていた間の超過は持ち越さず、戻ってから新たに数え直す。
    frames(governor, 24, 20, 6, true);
    assert.equal(governor.levelCap, DETAIL_TIERS - 1);
  });
}
