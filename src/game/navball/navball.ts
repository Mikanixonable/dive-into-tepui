// 表示設定(天球グリッド)の状態を保持する。
import { CelestialGridVisibility } from '../../render/celestial-grid';
import { NavballPanel } from './navball-panel';

const GRID_TOGGLE_ITEMS: readonly (readonly [keyof CelestialGridVisibility, string])[] = [
  ['eclipticPlane', '黄道面'],
  ['eclipticPole', '黄道極'],
  ['eclipticGrid', '黄道グリッド'],
  ['equatorPlane', '赤道面'],
  ['equatorPole', '赤道極'],
  ['equatorGrid', '赤道グリッド'],
];

export class Navball {
  gridVisibility: CelestialGridVisibility = {
    eclipticPlane: false, eclipticPole: false, eclipticGrid: false,
    equatorPlane: false, equatorPole: false, equatorGrid: false,
  };

  constructor(hudRoot: HTMLElement) {
    const panel = new NavballPanel(hudRoot, GRID_TOGGLE_ITEMS);
    panel.onGridToggle = (key, on) => {
      this.gridVisibility = { ...this.gridVisibility, [key]: on };
    };
  }
}
