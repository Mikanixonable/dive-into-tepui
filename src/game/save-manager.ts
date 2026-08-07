import { Game } from './game';
import { GameSaveData } from './save-data';

const SAVE_KEY = 'tepui.save';
const SAVE_VERSION = 1;

export class SaveManager {
  static save(game: Game): void {
    const data: GameSaveData = {
      version: SAVE_VERSION,
      stageId: game.activeStage.id,
      simTime: game.simTime,
      player: game.player ? game.player.serialize() : null,
      enemies: game.entities.enemies.map(e => e.serialize()),
      ammos: game.entities.ammos.map(a => a.serialize()),
      bases: game.entities.bases.map(b => b.serialize()),
    };
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
      console.log('Saved game state', data);
    } catch (err) {
      console.error('Failed to save', err);
    }
  }

  static load(game: Game): boolean {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(SAVE_KEY);
    } catch (err) {
      console.error('Failed to access localStorage', err);
      return false;
    }
    if (!raw) return false;

    try {
      const data: GameSaveData = JSON.parse(raw);
      if (data.version !== SAVE_VERSION) {
        console.warn('Save data version mismatch', data.version, '!=', SAVE_VERSION);
        return false;
      }
      
      // ステージが一致しているか確認。クリエイティブ以外でステージが異なる場合は現状サポートしない。
      if (game.activeStage.id !== data.stageId) {
        console.warn('Cannot load save data from different stage', data.stageId);
        return false;
      }
      
      game.restore(data);
      console.log('Loaded game state', data);
      return true;
    } catch (err) {
      console.error('Failed to parse or load save data', err);
      return false;
    }
  }
}
