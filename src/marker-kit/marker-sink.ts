// 各所有者がマーカー群を操作するためのインターフェース。毎フレームの登録を受け、表示状態を問い合わせ、破棄処理を行う。
import type { MarkerDeclaration } from './marker-declaration';
import type { MarkerVisibility } from './marker-visibility';

export interface MarkerSink extends MarkerVisibility {
  // このフレームに出すマーカーを宣言し直す。nowMs はフレームの実時刻 [ms]。
  // 空配列を渡せばこの群のマーカーは残らず消える。
  sync(items: readonly MarkerDeclaration[], nowMs: number): void;
  // この群のマーカーを残らず取り除く。呼んだ後のこの群は使えない。
  dispose(): void;
}
