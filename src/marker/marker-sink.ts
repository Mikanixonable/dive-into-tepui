// 持ち主がマーカー群へ触れる面。毎フレームの宣言を受け、出したかを答え、使い終えたら畳む。
import type { MarkerDeclaration } from './marker-declaration';
import type { MarkerVisibility } from './marker-visibility';

export interface MarkerSink extends MarkerVisibility {
  // このフレームに出すマーカーを宣言し直す。nowMs はフレームの実時刻 [ms]。
  // 空配列を渡せばこの群のマーカーは残らず消える。
  sync(items: readonly MarkerDeclaration[], nowMs: number): void;
  // この群のマーカーを残らず取り除く。呼んだ後のこの群は使えない。
  dispose(): void;
}
