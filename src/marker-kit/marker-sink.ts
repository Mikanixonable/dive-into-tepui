// 各所有者がマーカー群を操作するためのインターフェース。毎フレームの登録を受け、表示状態を問い合わせ、破棄処理を行う。
import type { MarkerDeclaration } from './marker-declaration';
// マーカーが画面に出ているかどうかの問い合わせ口。
export interface MarkerVisibility {
  // その id のマーカーを直前のフレームで画面へ出したか。遮蔽で薄れている途中も出していない扱い。
  shows(id: string): boolean;
}


export interface MarkerSink extends MarkerVisibility {
  // このフレームに出すマーカーを宣言し直す。nowMs はフレームの実時刻 [ms]。
  // 空配列を渡せばこの群のマーカーは残らず消える。
  sync(items: readonly MarkerDeclaration[], nowMs: number): void;
  // この群のマーカーを残らず取り除く。呼んだ後のこの群は使えない。
  dispose(): void;
}
