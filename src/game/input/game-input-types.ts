// 生入力からゲーム機能へ伝達する語彙。ゲーム操作(連続)・ゲームコマンド(単発)・
// キー割り当ての3つをここ1か所に置く。Input 実装やゲーム機能を import しない。

/** キー割り当てを raw input adapter と共有するための最小形。 */
export interface GameInputBinding {
  readonly code: string;
  readonly altCodes?: readonly string[];
}

/** 押下中である間、各フレームに通知できるゲーム操作。 */
export interface ContinuousGameAction {
  readonly kind: 'continuous';
  readonly id: string;
  readonly binding: GameInputBinding;
}

/** 押下エッジを1回だけ処理するゲームコマンド。 */
export interface GameCommand {
  readonly kind: 'command';
  readonly id: string;
  readonly binding: GameInputBinding;
}

/** コマンド定義の kind を各配線箇所で繰り返さないための生成関数。 */
export function gameCommand(id: string, binding: GameInputBinding): GameCommand {
  return { kind: 'command', id, binding };
}
