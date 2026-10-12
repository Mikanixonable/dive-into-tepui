// ラン跨ぎのユーザー設定(src/settings/user-settings.ts)の回帰テスト。中心は**既存ユーザーの
// localStorage との互換** — 保存の鍵と保存文字列の書式はコードの外に残っている期待値なので、
// これが動くと利用者の設定が黙って既定へ戻る。壊れた保存値からの復帰と、書き換えの配り方も見る。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { MemorySettingStorage } from '../../src/settings/stored-setting';
import { UserSettings } from '../../src/settings/user-settings';
import {
  DEFAULT_GRAPHICS, DEFAULT_GRAPHICS_SELECTION, formatGraphicsSelection, selectOverall, withGraphicsValue,
} from '../../src/render/graphics-selection';
import { DEFAULT_RENDER_STYLE } from '../../src/render/render-style';
import { DEFAULT_BGM_VOLUME } from '../../src/audio/bgm/bgm';
import { DEFAULT_MAP_DISPLAY_TOGGLES } from '../../src/game/map/display-toggles';
import { DEFAULT_GRID_VISIBILITY } from '../../src/render/celestial-grid';

// 保存の鍵。**利用者の localStorage に残っている文字列そのもの**なので、実装から導かずに直に書く。
const GRAPHICS_KEY = 'tepui.settings.graphics.v2';
const LEGACY_GRAPHICS_KEY = 'tepui.settings.graphics';
const RENDER_STYLE_KEY = 'tepui.settings.renderStyle';
const BGM_VOLUME_KEY = 'tepui.settings.bgm_vol';
const MAP_DISPLAY_TOGGLES_KEY = 'tepui.mapDisplayToggles';
const GRID_VISIBILITY_KEY = 'tepui.gridVisibility';

// 保存済みの値を仕込んだ保存先を作る。
function storageWith(entries: Readonly<Record<string, string>>): MemorySettingStorage {
  const storage = new MemorySettingStorage();
  for (const [key, text] of Object.entries(entries)) storage.write(key, text);
  return storage;
}

export function register(): void {
  test('user-settings: 保存済みの設定が、鍵も書式もそのまま読み戻る', () => {
    const settings = new UserSettings(storageWith({
      [GRAPHICS_KEY]: '{"quality":"low","preferences":{"exposureCompensation":2,"filmLut":"none"}}',
      [RENDER_STYLE_KEY]: 'schematic',
      [BGM_VOLUME_KEY]: '0.5',
      [MAP_DISPLAY_TOGGLES_KEY]: '{"planetOrbit":false,"dwarfOrbit":true}',
      [GRID_VISIBILITY_KEY]: '{"stars":false,"eclipticPlane":true}',
    }));
    assert.equal(settings.graphics.current.quality, 'low');
    assert.equal(settings.graphics.current.preferences.exposureCompensation, 2);
    assert.equal(settings.resolvedGraphics.current.exposureCompensation, 2);
    assert.equal(settings.renderStyle.current, 'schematic');
    assert.equal(settings.bgmVolume.current, 0.5);
    const toggles = settings.mapDisplayToggles.current;
    assert.equal(toggles.planetOrbit, false);
    assert.equal(toggles.dwarfOrbit, true);
    const grid = settings.gridVisibility.current;
    assert.equal(grid.stars, false);
    assert.equal(grid.eclipticPlane, true);
  });

  test('user-settings: 新しい鍵が無ければ、平らな値一式で保存した旧い鍵を読み替える', () => {
    const settings = new UserSettings(storageWith({
      [LEGACY_GRAPHICS_KEY]: '{"lodBias":0.5,"clouds":false,"antialias":1,"shadowSlotSize":2048}',
    }));
    const graphics = settings.resolvedGraphics.current;
    assert.equal(graphics.lodBias, 0.5);
    assert.equal(graphics.clouds, false);
    assert.equal(graphics.antialias, 1);
    assert.equal(graphics.shadowSlotSize, 2048);
  });

  test('user-settings: 新しい鍵があれば、旧い鍵は読まない', () => {
    const settings = new UserSettings(storageWith({
      [GRAPHICS_KEY]: '{"quality":"medium","preferences":{"exposureCompensation":1,"filmLut":"none"}}',
      [LEGACY_GRAPHICS_KEY]: '{"lodBias":0.5,"clouds":false}',
    }));
    assert.equal(settings.graphics.current.quality, 'medium');
    assert.equal(settings.resolvedGraphics.current.clouds, true);
  });

  test('user-settings: 書き込みは新しい鍵へ行き、旧い鍵には書かない', () => {
    const storage = storageWith({
      [LEGACY_GRAPHICS_KEY]: '{"lodBias":0.5}',
    });
    const settings = new UserSettings(storage);
    settings.graphics.set(selectOverall(settings.graphics.current, 'low'));
    assert.equal(storage.read(GRAPHICS_KEY), formatGraphicsSelection(settings.graphics.current));
    assert.equal(storage.read(LEGACY_GRAPHICS_KEY), '{"lodBias":0.5}', '旧い鍵が書き換えられた');
  });

  test('user-settings: 読めない保存値は既定へ落ちる', () => {
    const settings = new UserSettings(storageWith({
      [GRAPHICS_KEY]: '{"quality":"low"',
      [RENDER_STYLE_KEY]: 'holographic',
      [BGM_VOLUME_KEY]: 'loud',
      [MAP_DISPLAY_TOGGLES_KEY]: '{"planetOrbit":false',
      [GRID_VISIBILITY_KEY]: '{"stars":',
    }));
    assert.deepEqual(settings.graphics.current, DEFAULT_GRAPHICS_SELECTION);
    assert.deepEqual(settings.resolvedGraphics.current, DEFAULT_GRAPHICS);
    assert.equal(settings.renderStyle.current, DEFAULT_RENDER_STYLE);
    assert.equal(settings.bgmVolume.current, DEFAULT_BGM_VOLUME);
    assert.deepEqual(settings.mapDisplayToggles.current, DEFAULT_MAP_DISPLAY_TOGGLES);
    assert.deepEqual(settings.gridVisibility.current, DEFAULT_GRID_VISIBILITY);
  });

  // JSON として読めても値の形が違えば、重ねる先が無い。表の組を持つ2つの設定はここで既定へ戻る。
  test('user-settings: オブジェクトでない保存値は既定へ落ちる', () => {
    const settings = new UserSettings(storageWith({
      [MAP_DISPLAY_TOGGLES_KEY]: '"planetOrbit"',
      [GRID_VISIBILITY_KEY]: '3',
    }));
    assert.deepEqual(settings.mapDisplayToggles.current, DEFAULT_MAP_DISPLAY_TOGGLES);
    assert.deepEqual(settings.gridVisibility.current, DEFAULT_GRID_VISIBILITY);
  });

  test('user-settings: 解いた値は選び方が同じあいだ同じ参照で、書き換えると新しい参照になる', () => {
    const settings = new UserSettings(new MemorySettingStorage());
    const first = settings.resolvedGraphics.current;
    assert.equal(settings.resolvedGraphics.current, first, '同じ選び方から別の参照が返った');

    settings.graphics.set(withGraphicsValue(settings.graphics.current, 'lodBias', 0.5));
    const second = settings.resolvedGraphics.current;
    assert.notEqual(second, first, '書き換えたのに同じ参照が返った');
    assert.equal(second.lodBias, 0.5);
    assert.equal(settings.resolvedGraphics.current, second, '同じ選び方から別の参照が返った');
  });

  test('user-settings: 書き換えが購読者全員へ届き、解除すると止まる', () => {
    const settings = new UserSettings(new MemorySettingStorage());
    const settingView: number[] = [];
    const pauseMenu: number[] = [];
    const unsubscribe = settings.bgmVolume.subscribe((volume) => settingView.push(volume));
    settings.bgmVolume.subscribe((volume) => pauseMenu.push(volume));

    settings.bgmVolume.set(0.25);
    assert.deepEqual(settingView, [DEFAULT_BGM_VOLUME, 0.25]);
    assert.deepEqual(pauseMenu, [DEFAULT_BGM_VOLUME, 0.25]);

    unsubscribe();
    settings.bgmVolume.set(0.75);
    assert.deepEqual(settingView, [DEFAULT_BGM_VOLUME, 0.25], '解除したあとも届いている');
    assert.deepEqual(pauseMenu, [DEFAULT_BGM_VOLUME, 0.25, 0.75]);
  });

  test('user-settings: 書き換えた値が同じ保存先から読み戻る', () => {
    const storage = new MemorySettingStorage();
    const settings = new UserSettings(storage);
    settings.graphics.set(withGraphicsValue(settings.graphics.current, 'lodBias', 0.5));
    settings.renderStyle.set('schematic');
    settings.bgmVolume.set(0.25);

    const reloaded = new UserSettings(storage);
    assert.deepEqual(reloaded.graphics.current, settings.graphics.current);
    assert.deepEqual(reloaded.resolvedGraphics.current, settings.resolvedGraphics.current);
    assert.equal(reloaded.renderStyle.current, 'schematic');
    assert.equal(reloaded.bgmVolume.current, 0.25);
  });
}
