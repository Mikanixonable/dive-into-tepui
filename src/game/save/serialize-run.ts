// 動いているランを1件ぶんのセーブ本体へ畳む。各サブシステム自身の serialize を集めるだけで、
// どこへ何件残すかはランの外側が決める。
import type { Game } from '../game';
import { ephemerisContextFor } from '../../physics/ephemeris/ephemeris-context';
import { type GameSaveData, SAVE_VERSION } from './save-data';

export function serializeRun(game: Game): GameSaveData {
  const { phaseOffsets, earthSpinPhase0 } = game.celestialSystem.serialize();
  return {
    version: SAVE_VERSION,
    stageId: game.activeStage.id,
    simTime: game.simTime,
    ephemerisContext: { ...ephemerisContextFor(game.celestialSystem.epoch) },
    phaseOffsets,
    earthSpinPhase0,
    players: game.dynamicSystem.players.map((p) => p.serialize()),
    activePlayerId: game.player ? game.player.id : null,
    enemies: game.dynamicSystem.enemies.map((e) => e.serialize()),
    ammoPickups: game.dynamicSystem.ammoPickups.map((pickup) => pickup.serialize()),
    rcsFuelPickups: game.dynamicSystem.rcsFuelPickups.map((pickup) => pickup.serialize()),
    detachedBoosters: game.dynamicSystem.detachedBoosters.map((booster) => booster.serialize()),
    bases: game.dynamicSystem.bases.map((b) => b.serialize()),
    stage: game.activeStage.serialize(),
    camera: { view: game.viewManager.current, ...game.cameraSystem.serialize() },
    navTarget: game.navTarget.id !== null ? { id: game.navTarget.id, name: game.navTarget.name! } : null,
  };
}
