// 起動時に選ぶゲームの種別。'stage' は既存のステージ攻略、'creative' はマップから
// 自由に艦艇を配置して眺めるモード。
import type { StageId } from './stages/stage';

export type GameMode = 'stage' | 'creative';

// 起動選択画面(launch-select.ts)の確定結果。'stage' は従来どおり StageId を伴う。
export type LaunchSelection =
  | { readonly mode: 'stage'; readonly stage: StageId }
  | { readonly mode: 'creative' };
