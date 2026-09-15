// 表示パネルを持ち、その操作をラン跨ぎ設定の書き換えとして返して、書き戻された値をパネルの
// 表示状態へ当てる。天体分類・天球グリッド・軌道ガイドとタブの選択をそれぞれ別の設定として扱う。
import { catalogFamilyIndex } from '../../celestial/orbit-guide/orbit-guide-catalog';
import { normalizeOrbitGuideSettings } from '../../celestial/orbit-guide/orbit-guide-settings';
import { applyMapDisplayMode } from '../../map/display-toggles';
import { ViewOptionsPanel } from './view-options-panel';
import type { OrbitGuideSettings } from '../../celestial/orbit-guide/orbit-guide-settings';
import type { OrbitGuideGroupTab, ViewOptionsTab } from '../hud-selection';
import type { MapDisplayToggles } from '../../map/display-toggles';
import type { PanelCollapse } from '../panel-shell';
import type { CelestialGridVisibility } from '../../../render/celestial-grid';
import type { SettingValue } from '../../../settings/setting-value';

// 表示パネルが読み書きするラン跨ぎ設定。現在値を読み、書き換えは onXxxChange へ返す。
export interface ViewOptionsSettings {
  readonly mapDisplay: SettingValue<MapDisplayToggles>;
  readonly grid: SettingValue<CelestialGridVisibility>;
  readonly orbitGuide: SettingValue<OrbitGuideSettings>;
  readonly tab: SettingValue<ViewOptionsTab>;
  readonly orbitGuideGroupTab: SettingValue<OrbitGuideGroupTab>;
  onMapDisplayChange(value: MapDisplayToggles): void;
  onGridChange(value: CelestialGridVisibility): void;
  onOrbitGuideChange(value: OrbitGuideSettings): void;
  onTabChange(value: ViewOptionsTab): void;
  onOrbitGuideGroupTabChange(value: OrbitGuideGroupTab): void;
}

export class ViewOptionsControl {
  private readonly panel: ViewOptionsPanel;

  // root はパネルを差し込む先、collapse は折りたたみトグルの配線役。settings の現在値を
  // パネルへ当て、パネルの操作は settings の書き換えとして返す。
  public constructor(root: HTMLElement, collapse: PanelCollapse, settings: ViewOptionsSettings) {
    this.panel = new ViewOptionsPanel(root, collapse, catalogFamilyIndex());

    // 天体クラスの表示。1ボタンが循環する表示状態を、保存される boolean の組へ畳む。
    this.panel.onBodyClassModeChange = (key, mode) => {
      const next = applyMapDisplayMode(settings.mapDisplay.current, key, mode);
      settings.onMapDisplayChange(next);
      this.panel.setBodyClassToggles(next);
    };
    this.panel.setBodyClassToggles(settings.mapDisplay.current);

    // 天球グリッド。行見出しと面・極・網は、互いに独立したトグルとして書き戻す。
    this.panel.onGridToggle = (key, on) => {
      const next = { ...settings.grid.current, [key]: on };
      settings.onGridChange(next);
      this.panel.setGridVisibility(next);
    };
    this.panel.setGridVisibility(settings.grid.current);

    // 軌道ガイド(ゼロ速度曲線を含む)。編集結果は範囲・本数を丸めてから書き戻す。
    this.panel.onOrbitGuideChange = (edited) => {
      const next = normalizeOrbitGuideSettings(edited);
      settings.onOrbitGuideChange(next);
      this.panel.setOrbitGuideSettings(next);
    };
    this.panel.setOrbitGuideSettings(settings.orbitGuide.current);

    // タブの選択。ランを跨いで残るので、これも設定として書き戻す。
    this.panel.onTabChange = (tab) => {
      settings.onTabChange(tab);
      this.panel.setSelectedTab(tab);
    };
    this.panel.setSelectedTab(settings.tab.current);
    this.panel.onOrbitGuideGroupTabChange = (tab) => {
      settings.onOrbitGuideGroupTabChange(tab);
      this.panel.setOrbitGuideGroupTab(tab);
    };
    this.panel.setOrbitGuideGroupTab(settings.orbitGuideGroupTab.current);
  }

  // パネルを出すかどうかを切り替える。
  public setVisible(visible: boolean): void {
    this.panel.setVisible(visible);
  }

  // 描いている軌道ガイド線の総数を、本数の警告のためパネルへ渡す。
  public setOrbitGuideLineCount(total: number): void {
    this.panel.setOrbitGuideLineCount(total);
  }

  // パネルを取り除く。
  public dispose(): void {
    this.panel.dispose();
  }
}
