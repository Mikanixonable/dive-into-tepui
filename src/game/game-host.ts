// 周回をまたいで使い回す土台 — 起動時に1度だけ組み、そこへ Game が載る。
import type { OrbitGuideSettings } from './celestial/orbit-guide/orbit-guide-settings';
import type { FrameSections } from './frame-sections';
import type { Hud } from './hud/hud';
import type { MapDisplayToggles } from './map/display-toggles';
import type { RunSetting } from './run-setting';
import type { CelestialGridVisibility } from '../render/celestial-grid';
import type { GameScene } from '../render/scene';

export interface GameHost {
  readonly scene: GameScene;
  readonly hud: Hud;
  readonly sections: FrameSections;
  // マップに出す天体分類・個体種別のトグル。
  readonly mapDisplay: RunSetting<MapDisplayToggles>;
  readonly grid: RunSetting<CelestialGridVisibility>;
  readonly orbitGuide: RunSetting<OrbitGuideSettings>;
}
