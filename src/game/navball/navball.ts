// 表示設定(天球グリッド)の状態を保持し、localStorage へ永続化する。DOM は ViewOptionsPanel
// (表示パネル)に同居する — グリッドトグルの配線だけをここが担う。
import { CelestialGridVisibility } from '../../render/celestial-grid';
import type { ViewOptionsPanel } from '../hud/view-options-panel';

const DEFAULT_GRID_VISIBILITY: CelestialGridVisibility = {
  stars: true,
  ecliptic: true,
  eclipticPlane: false, eclipticPole: false, eclipticGrid: false,
  equator: true,
  equatorPlane: false, equatorPole: false, equatorGrid: false,
  eclipticScaleGrid: false,
  equatorScaleGrid: false,
  moonOrbitScaleGrid: false,
};

const STORAGE_KEY = 'tepui.gridVisibility';

// localStorage から表示設定を読み込む。取得できなければ既定値を返す。
function loadGridVisibility(): CelestialGridVisibility {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_GRID_VISIBILITY;
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_GRID_VISIBILITY;
    return { ...DEFAULT_GRID_VISIBILITY, ...parsed };
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

  constructor(viewOptionsPanel: ViewOptionsPanel) {
    viewOptionsPanel.onGridToggle = (key, on) => {
      this.gridVisibility = { ...this.gridVisibility, [key]: on };
      saveGridVisibility(this.gridVisibility);
    };
    viewOptionsPanel.setGridVisibility(this.gridVisibility);
  }
}
