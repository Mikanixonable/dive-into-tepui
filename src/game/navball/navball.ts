// 表示設定(基準モード・天球グリッド)の状態を保持する。navball 計器は廃止済み。
import { CelestialGridVisibility } from '../../render/celestial-grid';
import { NavballPanel } from './navball-panel';

export type NavballMode = 'self' | 'targetPro' | 'targetRetro';

const MODE_ITEMS: readonly (readonly [NavballMode, string])[] = [
  ['self', '自機'],
  ['targetPro', 'TGT+'],
  ['targetRetro', 'TGT-'],
];

const GRID_TOGGLE_ITEMS: readonly (readonly [keyof CelestialGridVisibility, string])[] = [
  ['eclipticPlane', '黄道面'],
  ['eclipticPole', '黄道極'],
  ['eclipticGrid', '黄道グリッド'],
  ['equatorPlane', '赤道面'],
  ['equatorPole', '赤道極'],
  ['equatorGrid', '赤道グリッド'],
];

export class Navball {
  mode: NavballMode = 'self';
  gridVisibility: CelestialGridVisibility = {
    eclipticPlane: false, eclipticPole: false, eclipticGrid: false,
    equatorPlane: false, equatorPole: false, equatorGrid: false,
  };

  private readonly panel: NavballPanel;

  constructor(hudRoot: HTMLElement) {
    this.panel = new NavballPanel(hudRoot, MODE_ITEMS, GRID_TOGGLE_ITEMS);
    this.panel.setMode(this.mode);
    this.panel.onModeSelect = (mode) => {
      this.mode = mode;
      this.panel.setMode(mode);
    };
    this.panel.onGridToggle = (key, on) => {
      this.gridVisibility = { ...this.gridVisibility, [key]: on };
    };
  }

  sync(_playerState: unknown, _att: unknown, _alive: boolean, targetState: object | null): void {
    this.panel.setTargetModeEnabled(targetState !== null);
    if (!targetState && this.mode !== 'self') {
      this.mode = 'self';
      this.panel.setMode('self');
    }
  }
}
