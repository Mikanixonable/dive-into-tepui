// ステージクラスの一覧と、id からの引き当て。
import type { StageClass } from './stage';
import type { CampaignAct } from '../campaign/campaign-state';
import { Stage00 } from './stage00';
import { Stage0 } from './stage0';
import { Stage1 } from './stage1';
import { Stage2 } from './stage2';
import { StageStoryLunar } from './stage-story-lunar';
import { StageStoryAct2 } from './stage-story-act2';
import { StageStoryAct3 } from './stage-story-act3';
import { StageStoryAct4 } from './stage-story-act4';
import { StageDebug } from './stage-debug';
import { StageDebugAltSystem } from './stage-debug-alt-system';
import { StageDebugLoad } from './stage-debug-load';
import { CreativeStage } from './creative-stage';

// 選択画面が並べる順。起動時の設定・選択画面のラベル・解放条件はすべてクラスの静的宣言から読む。
export const STAGE_CLASSES: readonly StageClass[] = [Stage00, Stage0, Stage1, Stage2, StageStoryLunar, StageStoryAct2, StageStoryAct3, StageStoryAct4, StageDebug, StageDebugAltSystem, StageDebugLoad, CreativeStage];

// キャンペーンの幕に対応する内部ステージ(GAME.md 11.2)。
export function storyStageClassForAct(act: CampaignAct): StageClass {
  if (act === 1) return StageStoryLunar;
  if (act === 3) return StageStoryAct3;
  if (act === 4) return StageStoryAct4;
  return StageStoryAct2;
}

// クエリパラメータ等、外部由来の未検証文字列を含む id からステージクラスを引く。該当が無ければ null。
export function findStageClass(id: string | null): StageClass | null {
  return STAGE_CLASSES.find((c) => c.id === id) ?? null;
}
