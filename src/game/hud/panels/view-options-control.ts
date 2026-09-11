// 表示パネルを持ち、その操作をラン跨ぎ設定の正本へ書き戻して、同じ値をパネルの表示状態へ
// 戻す。天体分類・天球グリッド・軌道ガイドはそれぞれ別の設定として読み書きする。
import { catalogFamilyIndex } from '../../celestial/orbit-guide/orbit-guide-catalog';
import { normalizeOrbitGuideSettings } from '../../celestial/orbit-guide/orbit-guide-settings';
import { applyMapDisplayMode } from '../../map/display-toggles';
import { applyGridToggle } from '../../../render/celestial-grid';
import { ViewOptionsPanel } from './view-options-panel';
import type { OrbitGuideSettings } from '../../celestial/orbit-guide/orbit-guide-settings';
import type { MapDisplayToggles } from '../../map/display-toggles';
import type { RunSetting } from '../../run-setting';
import type { CelestialGridVisibility } from '../../../render/celestial-grid';

export class ViewOptionsControl {
  private readonly panel: ViewOptionsPanel;

  // root はパネルを差し込む先。3つの設定を正本として読み書きし、現在値をパネルへ反映する。
  public constructor(
    root: HTMLElement,
    mapDisplay: RunSetting<MapDisplayToggles>,
    grid: RunSetting<CelestialGridVisibility>,
    orbitGuide: RunSetting<OrbitGuideSettings>,
  ) {
    this.panel = new ViewOptionsPanel(root, catalogFamilyIndex());

    // 天体クラスの表示。1ボタンが循環する表示状態を、保存される boolean の組へ畳む。
    this.panel.onBodyClassModeChange = (key, mode) => {
      const next = applyMapDisplayMode(mapDisplay.current, key, mode);
      mapDisplay.set(next);
      this.panel.setBodyClassToggles(next);
    };
    this.panel.setBodyClassToggles(mapDisplay.current);

    // 天球グリッド。親子のトグルの整合を取ってから正本にする。
    this.panel.onGridToggle = (key, on) => {
      const next = applyGridToggle(grid.current, key, on);
      grid.set(next);
      this.panel.setGridVisibility(next);
    };
    this.panel.setGridVisibility(grid.current);

    // 軌道ガイド(ゼロ速度曲線を含む)。編集結果は範囲・本数を丸めてから正本にする。
    this.panel.onOrbitGuideChange = (settings) => {
      const next = normalizeOrbitGuideSettings(settings);
      orbitGuide.set(next);
      this.panel.setOrbitGuideSettings(next);
    };
    this.panel.setOrbitGuideSettings(orbitGuide.current);
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
