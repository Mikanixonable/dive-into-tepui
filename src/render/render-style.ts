// 画面全体の見せ方の選択。選べる値と保存文字列との変換、フレーム間で見せ方が変わったか
// の判定を持つ。3D 世界を描くすべての画面が同じ1つの選択を共有する。

export type RenderStyle = 'realistic' | 'schematic';

// 選べる値と表示ラベルの組。並びがそのまま UI 上の並び順になる。
export const RENDER_STYLES: readonly (readonly [RenderStyle, string])[] = [
  ['realistic', '写実'],
  ['schematic', '模式図'],
];

// 保存が無いときの見せ方。
export const DEFAULT_RENDER_STYLE: RenderStyle = 'realistic';

// 保存された文字列を見せ方へ読み直す。保存値は利用者がいつ書いたか分からないので、現在の候補に
// 含まれるかまで見る。
export function parseRenderStyle(text: string | null): RenderStyle {
  return RENDER_STYLES.find(([id]) => id === text)?.[0] ?? DEFAULT_RENDER_STYLE;
}

// 見せ方を保存文字列へ書き出す。
export function formatRenderStyle(style: RenderStyle): string {
  return style;
}

// 毎フレーム渡される style から「前回の適用値と変わったか」だけを判定する。3D UI オブジェクトが
// 模式図/写実で見た目を差し替えるとき、変化していないフレームでの再適用を省くために使う。
export class RenderStyleGate {
  private applied: RenderStyle | null = null;

  // 変化していれば true を返し、直近の適用値をこの style で更新する。呼び出し側は true が
  // 返ったときだけ見た目を差し替えればよい。
  changed(style: RenderStyle): boolean {
    if (style === this.applied) return false;
    this.applied = style;
    return true;
  }
}
