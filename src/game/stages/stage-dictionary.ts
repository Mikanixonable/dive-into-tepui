// ステージ配列(STAGE_DEFINITIONS)の定義を責務とする。各ステージの振る舞い(init/update/
// checkWin/onWin)は stage-definition.ts の StageDefinition を継承した Stage00/Stage0/Stage1/
// Stage2(このフォルダ内の同名ファイル)が持つ — ここではインスタンス化と番号引きのみ行う。
import { Stage, StageIndex, StageInitData } from './stage';
import { Stage00 } from './stage00';
import { Stage0 } from './stage0';
import { Stage1 } from './stage1';
import { Stage2 } from './stage2';

export const DEFAULT_STAGE_INDEX: StageIndex = 1;

export const STAGE_DEFINITIONS: Stage[] = [
  new Stage00(),
  new Stage0(),
  new Stage1(),
  new Stage2(),
];

const STAGE_BY_INDEX = new Map<StageIndex, Stage>(STAGE_DEFINITIONS.map((stage) => [stage.index, stage]));

export function getStageDefinition(stage: number): Stage {
  return STAGE_BY_INDEX.get(stage as StageIndex) ?? STAGE_BY_INDEX.get(DEFAULT_STAGE_INDEX)!;
}

export function resolveStageInitData(def: Stage, enemyCount: number): StageInitData {
  return {
    magsLeft: def.initialAmmo.magsLeft,
    roundsInMag: def.initialAmmo.roundsInMag,
    briefingHtml: def.briefingHtml(enemyCount),
  };
}

export function resolveForcedStageFromQuery(stageParam: string | null): StageIndex | null {
  if (stageParam === null) return null;
  const forced = Number(stageParam);
  const matched = STAGE_DEFINITIONS.find((stage) => stage.index === forced);
  return matched?.index ?? null;
}
