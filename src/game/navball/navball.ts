// 表示設定(天球グリッド)の状態を保持し、localStorage へ永続化する。
import { CelestialGridVisibility } from '../../render/celestial-grid';
import { GridToggleGroup, NavballPanel } from './navball-panel';

const GRID_TOGGLE_GROUPS: readonly GridToggleGroup[] = [
  {
    categoryKey: 'ecliptic', label: '黄道',
    items: [['eclipticPlane', '⌒', '黄道面'], ['eclipticPole', '▲', '黄道極'], ['eclipticGrid', '⊞', '黄道グリッド']],
  },
  {
    categoryKey: 'equator', label: '赤道',
    items: [['equatorPlane', '⌒', '赤道面'], ['equatorPole', '▲', '赤道極'], ['equatorGrid', '⊞', '赤道グリッド']],
  },
];

const DEFAULT_GRID_VISIBILITY: CelestialGridVisibility = {
  ecliptic: true,
  eclipticPlane: false, eclipticPole: false, eclipticGrid: false,
  equator: true,
  equatorPlane: false, equatorPole: false, equatorGrid: false,
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

  constructor(hudRoot: HTMLElement) {
    const panel = new NavballPanel(hudRoot, GRID_TOGGLE_GROUPS);
    panel.onGridToggle = (key, on) => {
      this.gridVisibility = { ...this.gridVisibility, [key]: on };
      saveGridVisibility(this.gridVisibility);
    };
    panel.setGridVisibility(this.gridVisibility);
  }
}
