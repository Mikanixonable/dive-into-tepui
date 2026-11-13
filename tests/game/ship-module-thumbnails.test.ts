import * as assert from 'node:assert/strict';
import { moduleThumbnailUrl } from '../../src/game/hud/panels/ship-module-thumbnails';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import { test } from '../harness';

export function register(): void {
  // カタログの定義が参照する全 modelId が、サムネイル表で画像 URL へ解決できることを固定する。
  // modelId を共有する定義は重複して数えない。
  test('module thumbnails: カタログの全 modelId がサムネイルを解決できる', () => {
    const modelIds = new Set(SHIP_MODULE_CATALOG.all().map(definition => definition.modelId));
    const missing = [...modelIds].filter(modelId => moduleThumbnailUrl(modelId) === undefined);
    assert.deepEqual(missing, []);
  });
}
