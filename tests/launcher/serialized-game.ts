// いまの形式の版で書いた、始めたばかりのランの記録を組む。
import { SAVED_GAME_VERSION, type SavedGame } from '../../src/launcher/save/save-store';
import { EntityIdAllocators } from '../../src/game/dynamic/dynamic-entity/entity-id';
import { SimSpeedManager } from '../../src/game/dynamic/sim-speed-manager';
import { PlanNodeRules } from '../../src/game/plan/plan-node-rules';
import { RunEventLog } from '../../src/game/run-events';
import { ScoreCounter } from '../../src/game/stages/stage-utils/score-counter';
import { Viewer } from '../../src/game/viewer/viewer';
import { solarSystem } from '../../src/game/celestial/solar-system/solar-system';
import { ephemerisContextFor } from '../../src/physics/ephemeris/ephemeris-context';
import { TEST_EPOCH } from '../physics/test-helpers';

// ステージ stageId を回帰テストの元期で始め、まだ何も置いていないランの記録。
export function serializedGame(stageId: string): SavedGame {
  const events = new RunEventLog();
  return {
    version: SAVED_GAME_VERSION,
    progress: {
      stageId,
      ephemerisContext: ephemerisContextFor(TEST_EPOCH),
      dynamicSystem: {
        simTime: 0,
        entities: [],
        pendingSpawns: [],
        idAllocators: new EntityIdAllocators().serialize(),
      },
      simSpeedManager: SimSpeedManager.create(events).serialize(),
      controlSelection: null,
      stage: {
        scoreCounter: new ScoreCounter().serialize(),
        phase: 'playing',
        logistics: { resupplyCheckAt: 0, resupplyEnabled: false, rcsFuelResupplyEnabled: false },
      },
      planNodeRules: PlanNodeRules.create(events).serialize(),
    },
    viewer: Viewer.create({ current: null }, events, solarSystem('earth', null, TEST_EPOCH)).serialize(),
  };
}
