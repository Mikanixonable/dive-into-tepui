// 主たるポインタが pointer:coarse(タッチ等、指先程度の精度しか持たない)かどうかの判定。
// 起動時に一度だけ評価してモジュールスコープへ保持する — 毎フレーム matchMedia を
// 問い合わせる理由がない上、途中でポインタ種別が切り替わる環境(タッチ対応ノート PC で
// マウスも使う等)を追いかけ始めるとピック半径が操作の途中で変わりかねない。
const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

// 主たるポインタが pointer:coarse かどうかを返す。
export function isCoarsePointer(): boolean {
  return COARSE;
}

// pointer:coarse なら coarse、そうでなければ fine を返す。ピック半径・ヒット領域など
// coarse 環境でだけ広げたい閾値の選択に使う。
export function pickRadiusSq(fine: number, coarse: number): number {
  return COARSE ? coarse : fine;
}
