// ステージ配列(STAGES)の定義を責務とする。各ステージの振る舞い(init/update/
// checkWin/onWin)は stage.ts の Stage を継承した Stage00/Stage0/Stage1/Stage2
// (このフォルダ内の同名ファイル)が持つ — ここではインスタンス化と ID 引きのみ行う。
import { Stage, StageId } from './stage';
import type { Player } from '../player/player';
import type { Simulator } from '../orbit-entity/simulator';
import type { Hud } from '../hud/hud';
import { Stage00 } from './stage00';
import { Stage0 } from './stage0';
import { Stage1 } from './stage1';
import { Stage2 } from './stage2';

export const DEFAULT_STAGE_ID: StageId = '1';

export const STAGES: Stage[] = [
  new Stage00(),
  new Stage0(),
  new Stage1(),
  new Stage2(),
];

const STAGE_BY_ID = new Map<StageId, Stage>(STAGES.map((stage) => [stage.id, stage]));

export function getStage(id: string): Stage {
  return STAGE_BY_ID.get(id as StageId) ?? STAGE_BY_ID.get(DEFAULT_STAGE_ID)!;
}

export function initStage(stage: Stage, player: Player, simulator: Simulator, hud: Hud) {
    const enemyCount = stage.init(player, simulator);
    player.initAmmo(stage.initialAmmo.mags, stage.initialAmmo.rounds);
    hud.toast(stage.briefingHtml(enemyCount), 12000);
}

export function resolveStageFromId(stageParam: string | null): StageId | null {
  if (stageParam === null) return null;
  return STAGES.find((stage) => stage.id === stageParam)?.id ?? null;
}
