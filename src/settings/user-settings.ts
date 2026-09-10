// ラン跨ぎのユーザー設定の正本。設定ごとの現在値を1つずつ起こし、保存先のどの鍵へ載せるかを決める。
// 値の型・選択肢・保存文字列との変換は、それぞれの設定を所有するモジュールが持つ。

import { parseBgmVolume } from '../audio/bgm/bgm';
import { formatGraphics, parseGraphics } from '../render/graphics-settings';
import { parseRenderStyle } from '../render/render-style';
import { StoredSetting } from './stored-setting';
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

  // storage は設定一式を残す先。
  public constructor(storage: SettingStorage) {
    this.graphics = new StoredSetting(storage, 'tepui.settings.graphics', parseGraphics, formatGraphics);
    this.renderStyle = new StoredSetting(storage, 'tepui.settings.renderStyle', parseRenderStyle, (style) => style);
    this.bgmVolume = new StoredSetting(storage, 'tepui.settings.bgm_vol', parseBgmVolume, (vol) => String(vol));
  }
}
