// ラン跨ぎのユーザー設定の正本。設定ごとの現在値を1つずつ起こし、保存先のどの鍵へ載せるかを決める。
// 値の型・選択肢・保存文字列との変換は、それぞれの設定を所有するモジュールが持つ。

import { parseBgmVolume } from '../audio/bgm/bgm';
import { formatOrbitGuideSettings, parseOrbitGuideSettings } from '../game/celestial/orbit-guide/orbit-guide-settings';
import { formatMapDisplayToggles, parseMapDisplayToggles } from '../game/map/display-toggles';
import { formatGridVisibility, parseGridVisibility } from '../render/celestial-grid';
import { formatGraphics, parseGraphics } from '../render/graphics-settings';
import { parseRenderStyle } from '../render/render-style';
import { StoredSetting } from './stored-setting';
import type { OrbitGuideSettings } from '../game/celestial/orbit-guide/orbit-guide-settings';
import type { MapDisplayToggles } from '../game/map/display-toggles';
import type { CelestialGridVisibility } from '../render/celestial-grid';
import type { GraphicsSettingsData } from '../render/graphics-settings';
import type { RenderStyle } from '../render/render-style';
import type { SettingStorage } from './stored-setting';

export class UserSettings {
  // 描画の品質設定。
  public readonly graphics: StoredSetting<GraphicsSettingsData>;
  // 3D 世界を描く画面すべてが共有する見せ方。
  public readonly renderStyle: StoredSetting<RenderStyle>;
  // BGM のユーザー音量。0〜1。
  public readonly bgmVolume: StoredSetting<number>;
  // マップに出す天体分類・個体種別のトグル。
  public readonly mapDisplayToggles: StoredSetting<MapDisplayToggles>;
  // 天球グリッドの表示。
  public readonly gridVisibility: StoredSetting<CelestialGridVisibility>;
  // 軌道ガイドの設定。
  public readonly orbitGuide: StoredSetting<OrbitGuideSettings>;

  // storage は設定一式を残す先。鍵は**既存ユーザーの保存に残っている文字列**なので、
  // 生成の並びと一緒にここへ直に書く。
  public constructor(storage: SettingStorage) {
    // 画面全体に効く設定。設定ビューと一時停止メニューが書き換える。
    this.graphics = new StoredSetting(storage, 'tepui.settings.graphics', parseGraphics, formatGraphics);
    this.renderStyle = new StoredSetting(storage, 'tepui.settings.renderStyle', parseRenderStyle, (style) => style);
    this.bgmVolume = new StoredSetting(storage, 'tepui.settings.bgm_vol', parseBgmVolume, (vol) => String(vol));
    // マップの表示パネルが書き換える設定。ランの中から編集され、ランを跨いで残る。
    this.mapDisplayToggles = new StoredSetting(
      storage, 'tepui.mapDisplayToggles', parseMapDisplayToggles, formatMapDisplayToggles,
    );
    this.gridVisibility = new StoredSetting(
      storage, 'tepui.gridVisibility', parseGridVisibility, formatGridVisibility,
    );
    this.orbitGuide = new StoredSetting(
      storage, 'tepui.orbitGuide', parseOrbitGuideSettings, formatOrbitGuideSettings,
    );
  }
}
