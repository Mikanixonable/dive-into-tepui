// ラン跨ぎのユーザー設定(src/settings/user-settings.ts)の回帰テスト。中心は**既存ユーザーの
// localStorage との互換** — 保存の鍵と保存文字列の書式はコードの外に残っている期待値なので、
// これが動くと利用者の設定が黙って既定へ戻る。壊れた保存値からの復帰と、書き換えの配り方も見る。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { MemorySettingStorage } from '../../src/settings/stored-setting';
import { UserSettings } from '../../src/settings/user-settings';
import { DEFAULT_GRAPHICS, withGraphicsOption } from '../../src/render/graphics-settings';
import { DEFAULT_RENDER_STYLE } from '../../src/render/render-style';
import { DEFAULT_BGM_VOLUME } from '../../src/audio/bgm/bgm';
import { DEFAULT_MAP_DISPLAY_TOGGLES } from '../../src/game/map/display-toggles';
import { DEFAULT_GRID_VISIBILITY } from '../../src/render/celestial-grid';
import { DEFAULT_ORBIT_GUIDE_SETTINGS } from '../../src/game/celestial/orbit-guide/orbit-guide-settings';

// 保存の鍵。**利用者の localStorage に残っている文字列そのもの**なので、実装から導かずに直に書く。
const GRAPHICS_KEY = 'tepui.settings.graphics';
const RENDER_STYLE_KEY = 'tepui.settings.renderStyle';
const BGM_VOLUME_KEY = 'tepui.settings.bgm_vol';
const MAP_DISPLAY_TOGGLES_KEY = 'tepui.mapDisplayToggles';
const GRID_VISIBILITY_KEY = 'tepui.gridVisibility';
const ORBIT_GUIDE_KEY = 'tepui.orbitGuide';

// 保存済みの値を仕込んだ保存先を作る。
function storageWith(entries: Readonly<Record<string, string>>): MemorySettingStorage {
  const storage = new MemorySettingStorage();
  for (const [key, text] of Object.entries(entries)) storage.write(key, text);
  return storage;
}

export function register(): void {
  test('user-settings: 保存済みの設定が、鍵も書式もそのまま読み戻る', () => {
    const settings = new UserSettings(storageWith({
      [GRAPHICS_KEY]: '{"lodBias":0.5,"clouds":false,"antialias":1,"shadowSlotSize":2048}',
      [RENDER_STYLE_KEY]: 'schematic',
      [BGM_VOLUME_KEY]: '0.5',
      [MAP_DISPLAY_TOGGLES_KEY]: '{"planetOrbit":false,"dwarfOrbit":true}',
      [GRID_VISIBILITY_KEY]: '{"stars":false,"eclipticPlane":true}',
      [ORBIT_GUIDE_KEY]: '{"geostationary":false,"zeroVelocity":{"count":3}}',
    }));
    const graphics = settings.graphics.current;
    assert.equal(graphics.lodBias, 0.5);
    assert.equal(graphics.clouds, false);
    assert.equal(graphics.antialias, 1);
    assert.equal(graphics.shadowSlotSize, 2048);
    assert.equal(settings.renderStyle.current, 'schematic');
    assert.equal(settings.bgmVolume.current, 0.5);
    const toggles = settings.mapDisplayToggles.current;
    assert.equal(toggles.planetOrbit, false);
    assert.equal(toggles.dwarfOrbit, true);
    const grid = settings.gridVisibility.current;
    assert.equal(grid.stars, false);
    assert.equal(grid.eclipticPlane, true);
    const orbitGuide = settings.orbitGuide.current;
    assert.equal(orbitGuide.geostationary, false);
    // 入れ子の設定も、保存に無い項目だけが既定で埋まる。
    assert.equal(orbitGuide.zeroVelocity.count, 3);
    assert.equal(orbitGuide.zeroVelocity.jacobi, DEFAULT_ORBIT_GUIDE_SETTINGS.zeroVelocity.jacobi);
  });

  test('user-settings: 読めない保存値は既定へ落ちる', () => {
    const settings = new UserSettings(storageWith({
      [GRAPHICS_KEY]: '{"lodBias":0.5',
      [RENDER_STYLE_KEY]: 'holographic',
      [BGM_VOLUME_KEY]: 'loud',
      [MAP_DISPLAY_TOGGLES_KEY]: '{"planetOrbit":false',
      [GRID_VISIBILITY_KEY]: '{"stars":',
      [ORBIT_GUIDE_KEY]: '{"geostationary":',
    }));
    assert.deepEqual(settings.graphics.current, DEFAULT_GRAPHICS);
    assert.equal(settings.renderStyle.current, DEFAULT_RENDER_STYLE);
    assert.equal(settings.bgmVolume.current, DEFAULT_BGM_VOLUME);
    assert.deepEqual(settings.mapDisplayToggles.current, DEFAULT_MAP_DISPLAY_TOGGLES);
    assert.deepEqual(settings.gridVisibility.current, DEFAULT_GRID_VISIBILITY);
    assert.deepEqual(settings.orbitGuide.current, DEFAULT_ORBIT_GUIDE_SETTINGS);
  });

  // JSON として読めても値の形が違えば、重ねる先が無い。表の組を持つ3つの設定はここで既定へ戻る。
  test('user-settings: オブジェクトでない保存値は既定へ落ちる', () => {
    const settings = new UserSettings(storageWith({
      [MAP_DISPLAY_TOGGLES_KEY]: '"planetOrbit"',
      [GRID_VISIBILITY_KEY]: '3',
      [ORBIT_GUIDE_KEY]: 'true',
    }));
    assert.deepEqual(settings.mapDisplayToggles.current, DEFAULT_MAP_DISPLAY_TOGGLES);
    assert.deepEqual(settings.gridVisibility.current, DEFAULT_GRID_VISIBILITY);
    assert.deepEqual(settings.orbitGuide.current, DEFAULT_ORBIT_GUIDE_SETTINGS);
  });

  test('user-settings: 知らない鍵は捨て、欠けた鍵と候補外の値だけを既定で埋める', () => {
    const settings = new UserSettings(storageWith({
      [GRAPHICS_KEY]: '{"lodBias":0.5,"clouds":"yes","unknownOption":7}',
    }));
    const graphics = settings.graphics.current;
    assert.ok(!('unknownOption' in graphics), '表に無い鍵が残っている');
    assert.equal(graphics.lodBias, 0.5, '候補にある保存値が残らない');
    assert.equal(graphics.clouds, DEFAULT_GRAPHICS.clouds, '候補外の値が既定へ落ちない');
    assert.equal(graphics.antialias, DEFAULT_GRAPHICS.antialias, '保存に無い鍵が既定で埋まらない');
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
    settings.graphics.set(withGraphicsOption(settings.graphics.current, 'lodBias', 0.5));
    settings.renderStyle.set('schematic');
    settings.bgmVolume.set(0.25);

    const reloaded = new UserSettings(storage);
    assert.deepEqual(reloaded.graphics.current, settings.graphics.current);
    assert.equal(reloaded.renderStyle.current, 'schematic');
    assert.equal(reloaded.bgmVolume.current, 0.25);
  });
}
