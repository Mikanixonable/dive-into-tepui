// ステージクラスの一覧と、id からの引き当て。
import type { StageClass } from './stage';
import { Stage1 } from './stage1';
import { Stage2 } from './stage2';
import { Stage3 } from './stage3';
import { Stage4 } from './stage4';
import { StageDebug } from './stage-debug';
import { StageDebugAltSystem } from './stage-debug-alt-system';
import { StageDebugLoad } from './stage-debug-load';
import { CreativeStage } from './creative-stage';

// 選択画面が並べる順。起動時の設定・選択画面のラベル・解放条件はすべてクラスの静的宣言から読む。
export const STAGE_CLASSES: readonly StageClass[] = [Stage1, Stage2, Stage3, Stage4, StageDebug, StageDebugAltSystem, StageDebugLoad, CreativeStage];

// ステージ番号の付け替え(00→1・0→2・1→3・2→4)以前に保存された id の読み替え表。
// 記録・セーブ・URL に残った旧番号は、新しい番号へ読み替えて引き継ぐ(SPEC GAME.md 3)。
const STAGE_ID_ALIASES: Readonly<Record<string, string>> = {
  '00': '1', '0': '2', '1': '3', '2': '4',
};

// 旧番号を含むかもしれないステージ id を、現在の id へ読み替える。対応の無い id はそのまま返す。
export function normalizeStageId(id: string): string {
  return STAGE_ID_ALIASES[id] ?? id;
}

// クエリパラメータ等、外部由来の未検証文字列を含む id からステージクラスを引く。該当が無ければ null。
export function findStageClass(id: string | null): StageClass | null {
  if (id === null) return null;
  return STAGE_CLASSES.find((c) => c.id === normalizeStageId(id)) ?? null;
}
