// 周回をまたいで使い回す土台 — 起動時に1度だけ組み、そこへ Game が載る。
import type { OrbitGuideSettings } from './celestial/orbit-guide/orbit-guide-settings';
import type { FrameSections } from './frame-sections';
import type { Hud } from './hud/hud';
import type { MapDisplayToggles } from './map/display-toggles';
import type { RunSetting } from './run-setting';
import type { CelestialGridVisibility } from '../render/celestial-grid';
import type { GameScene } from '../render/scene';
import type { MarkerDevice } from '../marker/marker-device';

export interface GameHost {
  readonly scene: GameScene;
  readonly hud: Hud;
  // 画面へ重ねるマーカーの装置。周回をまたいで使い回す。
  readonly markers: MarkerDevice;
  readonly sections: FrameSections;
  // マップに出す天体分類・個体種別のトグル。
  readonly mapDisplay: RunSetting<MapDisplayToggles>;
  readonly grid: RunSetting<CelestialGridVisibility>;
  readonly orbitGuide: RunSetting<OrbitGuideSettings>;
}
