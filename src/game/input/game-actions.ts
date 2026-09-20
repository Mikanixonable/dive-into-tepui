// 生入力からゲーム機能へ伝達する、フレーム内の入力状態データ構造。
// このファイルは具体的な Input 実装やゲーム機能を import しない。

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
