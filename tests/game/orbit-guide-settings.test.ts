// 軌道ガイドの設定をセーブから読み直す経路の回帰テスト。セーブを読み込むとそのセーブの選択になり
// (INVARIANTS.md §6)、記録に無い項目は既定値で補われる(SAVE.md「形式の版」)。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  DEFAULT_ORBIT_GUIDE_SETTINGS, deserializeOrbitGuideSettings,
} from '../../src/game/viewer/orbit-guide-settings';
import type { OrbitGuideSettings } from '../../src/game/viewer/orbit-guide-settings';

export function register(): void {
  test('orbit-guide-settings: セーブへ書いた設定がそのまま読み戻る', () => {
    const chosen: OrbitGuideSettings = {
      ...DEFAULT_ORBIT_GUIDE_SETTINGS,
      geostationary: false,
      systems: { ...DEFAULT_ORBIT_GUIDE_SETTINGS.systems, 'sun-mars': true },
      molniya: { ...DEFAULT_ORBIT_GUIDE_SETTINGS.molniya, on: true, raan: 45 },
    };
    assert.deepEqual(deserializeOrbitGuideSettings(JSON.parse(JSON.stringify(chosen))), chosen);
  });

  test('orbit-guide-settings: セーブに無い項目だけが既定で埋まる', () => {
    assert.deepEqual(deserializeOrbitGuideSettings(undefined), DEFAULT_ORBIT_GUIDE_SETTINGS);
    // 入れ子の項目が欠けた記録。
    const saved: Partial<OrbitGuideSettings> = JSON.parse('{"geostationary":false,"zeroVelocity":{"count":3}}');
    const restored = deserializeOrbitGuideSettings(saved);
    assert.equal(restored.geostationary, false);
    assert.equal(restored.zeroVelocity.count, 3);
    assert.equal(restored.zeroVelocity.jacobi, DEFAULT_ORBIT_GUIDE_SETTINGS.zeroVelocity.jacobi);
    assert.deepEqual(restored.lissajous, DEFAULT_ORBIT_GUIDE_SETTINGS.lissajous);
  });
}
