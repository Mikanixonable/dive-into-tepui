// 配色の選択 id のラン跨ぎ正本。

import { StoredSetting, browserSettingStorage } from './stored-setting';

// 選ばれている配色の id。未保存のときは空文字。
export const themeIdSetting = new StoredSetting<string>(
  browserSettingStorage,
  'tepui.theme-palette',
  (text) => text ?? '',
  (id) => id,
);
