// 表示設定(天球グリッド)の状態を保持する。
import { CelestialGridVisibility } from '../../render/celestial-grid';
import { GridToggleGroup, NavballPanel } from './navball-panel';
import { DIRECTION_GLYPH } from '../marker/marker-glyphs';

const GRID_TOGGLE_GROUPS: readonly GridToggleGroup[] = [
  {
    categoryKey: 'ecliptic', label: '黄道',
    items: [['eclipticPlane', '⌒', '黄道面'], ['eclipticPole', DIRECTION_GLYPH.axis, '黄道極'], ['eclipticGrid', '⊞', '黄道グリッド']],
  },
  {
    categoryKey: 'equator', label: '赤道',
    items: [['equatorPlane', '⌒', '赤道面'], ['equatorPole', DIRECTION_GLYPH.axis, '赤道極'], ['equatorGrid', '⊞', '赤道グリッド']],
  },
];

export class Navball {
  gridVisibility: CelestialGridVisibility = {
    ecliptic: true,
    eclipticPlane: false, eclipticPole: false, eclipticGrid: false,
    equator: true,
    equatorPlane: false, equatorPole: false, equatorGrid: false,
  };

  constructor(hudRoot: HTMLElement) {
    const panel = new NavballPanel(hudRoot, GRID_TOGGLE_GROUPS);
    panel.onGridToggle = (key, on) => {
      this.gridVisibility = { ...this.gridVisibility, [key]: on };
    };
    panel.setGridVisibility(this.gridVisibility);
  }
}
