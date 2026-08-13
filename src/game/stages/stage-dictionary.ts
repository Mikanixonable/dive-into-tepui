// ステージクラスの一覧と、id からの引き当て。
import { StageClass } from './stage';
import { Stage00 } from './stage00';
import { Stage0 } from './stage0';
import { Stage1 } from './stage1';
import { Stage2 } from './stage2';
import { StageDebug } from './stage-debug';
import { StageDebugAltSystem } from './stage-debug-alt-system';
import { StageDebugLoad } from './stage-debug-load';
import { CreativeStage } from './creative-stage';

// 選択画面が並べる順。起動時の設定・選択画面のラベル・解放条件はすべてクラスの静的宣言から読む。
export const STAGE_CLASSES: readonly StageClass[] = [Stage00, Stage0, Stage1, Stage2, StageDebug, StageDebugAltSystem, StageDebugLoad, CreativeStage];

// クエリパラメータ等、外部由来の未検証文字列を含む id からステージクラスを引く。該当が無ければ null。
export function findStageClass(id: string | null): StageClass | null {
  return STAGE_CLASSES.find((c) => c.id === id) ?? null;
}
