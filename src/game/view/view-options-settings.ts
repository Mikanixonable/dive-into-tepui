// 表示パネルが読み書きする、セーブを跨いで共通の設定。現在値を読み、書き換えは onXxxChange へ返す。
import type { OrbitGuideGroupTab, ViewOptionsTab } from './view-preferences';
import type { MapDisplayToggles } from '../map/display-toggles';
import type { CelestialGridVisibility } from '../../render/celestial/celestial-grid';
import type { SettingValue } from '../../settings/setting-value';
import type { RenderStyle } from '../../render/render-style';

export interface ViewOptionsSettings {
  readonly mapDisplay: SettingValue<MapDisplayToggles>;
  readonly grid: SettingValue<CelestialGridVisibility>;
  readonly tab: SettingValue<ViewOptionsTab>;
  readonly orbitGuideGroupTab: SettingValue<OrbitGuideGroupTab>;
  readonly renderStyle: SettingValue<RenderStyle>;
  onMapDisplayChange(value: MapDisplayToggles): void;
  onGridChange(value: CelestialGridVisibility): void;
  onTabChange(value: ViewOptionsTab): void;
  onOrbitGuideGroupTabChange(value: OrbitGuideGroupTab): void;
  onRenderStyleChange(value: RenderStyle): void;
}
