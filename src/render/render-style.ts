// 画面全体の見せ方の選択。値の正本と localStorage への永続を持つ。3D 世界を描くすべての
// 画面が同じ1つの選択を共有する。

export type RenderStyle = 'realistic' | 'schematic';

// 選べる値と表示ラベルの組。並びがそのまま UI 上の並び順になる。
export const RENDER_STYLES: readonly (readonly [RenderStyle, string])[] = [
  ['realistic', '写実'],
  ['schematic', '模式図'],
];

const STORAGE_KEY = 'tepui.settings.renderStyle';
const DEFAULT_STYLE: RenderStyle = 'realistic';

// 保存値は利用者がいつ書いたか分からないので、現在の候補に含まれるかまで見る。
function loadStored(): RenderStyle {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return RENDER_STYLES.find(([id]) => id === raw)?.[0] ?? DEFAULT_STYLE;
  } catch {
    return DEFAULT_STYLE;
  }
}

type StyleListener = (style: RenderStyle) => void;

export class RenderStyleSetting {
  private style: RenderStyle = loadStored();
  private readonly listeners = new Set<StyleListener>();

  get current(): RenderStyle { return this.style; }

  // 値を差し替え、保存と購読者への通知まで行う。
  set(style: RenderStyle): void {
    if (style === this.style) return;
    this.style = style;
    try {
      localStorage.setItem(STORAGE_KEY, style);
    } catch {
      // 保存できなくてもこのセッションの選択は生きている。
    }
    for (const listener of this.listeners) listener(style);
  }

  // 変更を購読する。登録時に現在値で一度呼ぶので、購読側は初期反映を自前で書かなくてよい。
  subscribe(listener: StyleListener): () => void {
    this.listeners.add(listener);
    listener(this.style);
    return () => this.listeners.delete(listener);
  }
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
