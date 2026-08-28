// レスポンシブブレークポイントの唯一の定義。幅は compact(<760px)/medium(760〜1183px)/
// wide(1184px以上)の3クラスとし、coarse(pointer:coarse)・short(高さ<500px)を直交する2軸として
// 併用する。各 CSS ファイルはここが export するメディアクエリ文字列だけを参照し、
// 900px/520px 等の閾値を自分では書かない。

export const COMPACT_MAX_WIDTH = 759; // これ以下が compact。
export const MEDIUM_MAX_WIDTH = 1183; // これ以下が medium(compact を含む)。
export const SHORT_MAX_HEIGHT = 499; // これ以下が short。

export const MQ_COARSE = '(pointer: coarse)';
export const MQ_SHORT = `(max-height: ${SHORT_MAX_HEIGHT}px)`;
// medium 以下(medium・compact の両方)。coarse ポインタは画面幅に関わらず同じ扱いにする —
// 広い画面でも指先操作なら余白・タップ領域は medium 相当に寄せる。
export const MQ_MEDIUM_DOWN = `(max-width: ${MEDIUM_MAX_WIDTH}px), ${MQ_COARSE}`;
// compact のみ。
export const MQ_COMPACT = `(max-width: ${COMPACT_MAX_WIDTH}px)`;
// coarse と short の組み合わせ(横持ちスマホ等、縦幅が狭い上に指操作)。
export const MQ_COARSE_SHORT = `${MQ_COARSE} and ${MQ_SHORT}`;

// 現在のビューポート幅が compact かどうかをその場で判定する。pointer:coarse の判定
// (pointer-precision.ts の isCoarsePointer)と異なり起動時に固定せず毎回評価する —
// 画面幅は回転・リサイズで実際に変わるため、頻繁に呼ばれる per-frame の経路ではなく
// パネルを開く/組み立てるという離散的な瞬間に読む前提とし、都度の再評価で構わない。
export function isCompactViewport(): boolean {
  return typeof matchMedia === 'function' && matchMedia(MQ_COMPACT).matches;
}
