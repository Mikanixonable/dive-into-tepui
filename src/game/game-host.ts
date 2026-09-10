// 周回をまたいで使い回す土台 — 起動時に1度だけ組み、そこへ Game が載る。
import type { FrameSections } from './frame-sections';
import type { Hud } from './hud/hud';
import type { GameScene } from '../render/scene';

export interface GameHost {
  readonly scene: GameScene;
  readonly hud: Hud;
  readonly sections: FrameSections;
}
