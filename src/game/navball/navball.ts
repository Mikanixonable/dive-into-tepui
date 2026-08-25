// 表示設定(天球グリッド・軌道ガイド)の状態を保持し、localStorage へ永続化する。
// DOM は ViewOptionsPanel(表示パネル)に同居する — トグル・設定の配線だけをここが担う。
import { applyGridToggle, CelestialGridVisibility, normalizeGridVisibility } from '../../render/celestial-grid';
import {
  loadOrbitGuideSettings,
  normalizeOrbitGuideSettings,
  OrbitGuideSettings,
  saveOrbitGuideSettings,
} from '../celestial/orbit-guide-settings';
import type { ViewOptionsPanel } from '../hud/panels/view-options-panel';

const DEFAULT_GRID_VISIBILITY: CelestialGridVisibility = {
  stars: true,
  ecliptic: false,
  eclipticPlane: false, eclipticPole: false, eclipticGrid: false,
  equator: false,
  equatorPlane: false, equatorPole: false, equatorGrid: false,
  eclipticScaleGrid: false,
  equatorScaleGrid: false,
  moonOrbitScaleGrid: false,
  moonEquatorScaleGrid: false,
};

const STORAGE_KEY = 'tepui.gridVisibility';

// localStorage から表示設定を読み込む。取得できなければ既定値を返す。
function loadGridVisibility(): CelestialGridVisibility {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_GRID_VISIBILITY;
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_GRID_VISIBILITY;
    return normalizeGridVisibility({ ...DEFAULT_GRID_VISIBILITY, ...parsed });
  } catch {
    return DEFAULT_GRID_VISIBILITY;
  }
}

// 表示設定を localStorage へ保存する。
function saveGridVisibility(v: CelestialGridVisibility): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch {
    /* localStorage 不可なら保存しない(次回リロード時は既定値に戻る) */
  }
}

export class Navball {
  gridVisibility: CelestialGridVisibility = loadGridVisibility();
  orbitGuideSettings: OrbitGuideSettings = loadOrbitGuideSettings();
  // 軌道ガイドタブの設定が変わるたびに呼ばれる(描画側が新しい設定を受け取るための口)。
  onOrbitGuideSettingsChange: ((settings: OrbitGuideSettings) => void) | null = null;

  constructor(viewOptionsPanel: ViewOptionsPanel) {
    viewOptionsPanel.onGridToggle = (key, on) => {
      this.gridVisibility = applyGridToggle(this.gridVisibility, key, on);
      saveGridVisibility(this.gridVisibility);
      viewOptionsPanel.setGridVisibility(this.gridVisibility);
    };
    viewOptionsPanel.setGridVisibility(this.gridVisibility);

    viewOptionsPanel.onOrbitGuideChange = (settings) => {
      this.orbitGuideSettings = normalizeOrbitGuideSettings(settings);
      saveOrbitGuideSettings(this.orbitGuideSettings);
      viewOptionsPanel.setOrbitGuideSettings(this.orbitGuideSettings);
      this.onOrbitGuideSettingsChange?.(this.orbitGuideSettings);
    };
    viewOptionsPanel.setOrbitGuideSettings(this.orbitGuideSettings);

    // ゼロ速度曲線はガイドタブに置くが、値は軌道ガイド設定の一部として同じ正本が持つ。
    viewOptionsPanel.onZeroVelocityChange = (zeroVelocity) => {
      this.orbitGuideSettings = normalizeOrbitGuideSettings({ ...this.orbitGuideSettings, zeroVelocity });
      saveOrbitGuideSettings(this.orbitGuideSettings);
      viewOptionsPanel.setZeroVelocitySettings(this.orbitGuideSettings.zeroVelocity);
      this.onOrbitGuideSettingsChange?.(this.orbitGuideSettings);
    };
    viewOptionsPanel.setZeroVelocitySettings(this.orbitGuideSettings.zeroVelocity);
  }
}
