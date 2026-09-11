// 画面全体の見せ方(写実/模式図)。選べる値、保存文字列との変換、フレーム間で見せ方が変わったか
// の判定。

export type RenderStyle = 'realistic' | 'schematic';

// 選べる値と表示ラベルの組。並びがそのまま UI 上の並び順になる。
export const RENDER_STYLES: readonly (readonly [RenderStyle, string])[] = [
  ['realistic', '写実'],
  ['schematic', '模式図'],
];

// 保存が無いときの見せ方。
export const DEFAULT_RENDER_STYLE: RenderStyle = 'realistic';

// 保存された文字列を見せ方へ読み直す。候補に無い値なら既定に戻る。
export function parseRenderStyle(text: string | null): RenderStyle {
  return RENDER_STYLES.find(([id]) => id === text)?.[0] ?? DEFAULT_RENDER_STYLE;
}

// 見せ方を保存文字列へ書き出す。
export function formatRenderStyle(style: RenderStyle): string {
  return style;
}

// 見せ方が前回の適用値から変わったかを判定する。毎フレーム changed を呼び、true のときに
// 見た目を差し替える。
export class RenderStyleGate {
  private applied: RenderStyle | null = null;

  // 変化していれば true を返し、適用値をこの style へ更新する。初回は必ず true。
  public changed(style: RenderStyle): boolean {
    if (style === this.applied) return false;
    this.applied = style;
    return true;
  }
}
