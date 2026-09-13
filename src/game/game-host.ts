// 周回をまたいで使い回す土台 — 起動時に1度だけ組み、そこへ Game が載る。
import type { FrameSections } from './frame-sections';
import type { Hud } from './hud/hud';
import type { ViewOptionsSettings } from './hud/panels/view-options-control';
import type { GameScene } from '../render/scene';
import type { MarkerDevice } from '../marker/marker-device';
import type { SettingValue } from '../settings/setting-value';
import type { ThemePalette } from '../theme';

export interface GameHost {
  readonly scene: GameScene;
  readonly hud: Hud;
  // 画面へ重ねるマーカーの装置。
  readonly markers: MarkerDevice;
  readonly sections: FrameSections;
  // マップ・天球・軌道ガイドの表示設定。
  readonly viewOptions: ViewOptionsSettings;
  // 選ばれている配色。3D 描画と canvas へ渡す色の出どころ。
  readonly themePalette: SettingValue<ThemePalette>;
}
