// 設定メニューの「描画」面。品質プリセットと、描画品質設定の全項目を群ごとに並べる。
// 並びも見出しも GRAPHICS_GROUPS・GRAPHICS_OPTIONS の表からそのまま組む。
import {
  GRAPHICS_GROUPS, GRAPHICS_OPTIONS, GraphicsSettings, graphicsOptionKeys,
  type ChoiceValue, type GraphicsOptionKey, type GraphicsTarget, type QualityPreset,
} from '../../../render/graphics-settings';
import { Pulldown, SegmentedControl, ToggleSwitch, injectOnce, type PulldownColumn } from '../widgets';

// このパネル自身の CSS。**置き場のセレクタに閉じない** — 設定ビューの中だけでなく、
// 実験環境(tools/render-lab)の素の版面の上でも同じ形に組み上がる必要がある。
//
// **余白を持つ規則は `#hud` を冠した枝を併記する。** HUD は `#hud, #hud *` で margin と
// padding を一括して 0 へ落としており、その詳細度(1,0,0)はクラス 1 つ(0,1,0)より強い —
// 素のクラスだけで書くと、HUD の中でだけ群の間隔が無言で潰れる。
const STYLE = `
.gp-body, #hud .gp-body {
  display: flex; flex-direction: column; gap: var(--space-4); margin-top: var(--space-4);
}
.gp-group, #hud .gp-group {
  display: flex; flex-direction: column; gap: var(--space-4);
  padding-top: var(--space-4); border-top: 1px solid var(--edge);
}
.gp-group-title {
  margin: 0; color: var(--color-primary); font-size: var(--font-xxs); letter-spacing: 0.12em;
}
`;

const PRESET_ITEMS: readonly (readonly [QualityPreset, string])[] = [
  ['low', '低'], ['medium', '中'], ['high', '高'],
];

// 既定では 1 項目も伏せない。
const NO_HIDDEN_KEYS: ReadonlySet<GraphicsOptionKey> = new Set();

// プルダウンで選ぶ項目の列。描画設定の項目はどれも1列しか持たない。
type SelectColumns = readonly [PulldownColumn<ChoiceValue>];

// 項目1つぶんのコントロール。現在値から点灯を引き直す口だけを持つ。
interface OptionControl {
  readonly key: GraphicsOptionKey;
  readonly show: (value: boolean | ChoiceValue) => void;
}

// **点灯は設定の押し出し先として引き直す** — 実験環境では撮影の駆動が UI を通さずに項目を
// 書き換えるので、自分の操作だけを起点にすると表示が実際の設定とずれる。
export class GraphicsPanel implements GraphicsTarget {
  public readonly element: HTMLElement;

  private readonly preset: SegmentedControl<QualityPreset>;
  private readonly controls: readonly OptionControl[];

  // プリセットの列を先頭へ置き、続けて群ごとの節を並べる。どの操作も graphics へ書いてから
  // sync() で全コントロールの点灯を引き直すので、点灯の正本は常にそちら側にある。
  //
  // hidden は**この置き場では切り替えても何も起きない項目**。並べると嘘になるので出さない
  // (項目が減って空になった群は、見出しごと消える)。
  public constructor(
    private readonly graphics: GraphicsSettings,
    hidden: ReadonlySet<GraphicsOptionKey> = NO_HIDDEN_KEYS,
  ) {
    injectOnce('graphics-panel', STYLE);
    this.element = document.createElement('div');
    this.element.className = 'gp-body';

    this.preset = new SegmentedControl('品質プリセット', PRESET_ITEMS, (preset) => {
      this.graphics.applyPreset(preset);
    });
    this.element.appendChild(this.preset.element);

    // 空の群は見出しごと出さない。
    const controls: OptionControl[] = [];
    for (const [group, title] of GRAPHICS_GROUPS) {
      const keys = graphicsOptionKeys(group).filter((key) => !hidden.has(key));
      if (keys.length === 0) continue;
      const section = document.createElement('div');
      section.className = 'gp-group';
      const heading = document.createElement('h4');
      heading.className = 'gp-group-title';
      heading.textContent = title;
      section.appendChild(heading);
      for (const key of keys) controls.push(this.addControl(section, key));
      this.element.appendChild(section);
    }
    this.controls = controls;

    // **コントロールを組み終えてから登録する** — bind は現在値を即座に押し出すので、
    // 引き直す先が揃っていないうちに呼ばれると空振りする。
    graphics.bind(this);
  }

  // 設定が変わるたびに全コントロールの点灯を引き直す。
  public applyGraphics(): void {
    this.sync();
  }

  // 項目1つぶんのコントロールを組んで節へ並べる。真偽はトグルスイッチ — 2値の ON/OFF に
  // セグメントコントロールを使わない。選択肢の並べ方は表の kind が決める。
  private addControl(section: HTMLElement, key: GraphicsOptionKey): OptionControl {
    const option = GRAPHICS_OPTIONS[key];
    if (option.kind === 'toggle') {
      const widget = new ToggleSwitch(option.label, (on) => this.write(key, on));
      section.appendChild(widget.element);
      return { key, show: (value) => widget.setOn(value === true) };
    }
    // 反映ボタンは添えない — 見比べながら選ぶものなので、選び直した時点で画面へ出す。
    if (option.kind === 'select') {
      const columns: SelectColumns = [{ items: option.items }];
      const widget = new Pulldown(option.label, columns, null, ([value]) => this.write(key, value));
      section.appendChild(widget.element);
      return { key, show: (value) => { if (typeof value !== 'boolean') widget.setSelected(0, value); } };
    }
    const widget = new SegmentedControl<ChoiceValue>(option.label, option.items, (value) => this.write(key, value));
    section.appendChild(widget.element);
    return { key, show: (value) => widget.setSelected(typeof value === 'boolean' ? null : value) };
  }

  // 項目1つを書き換える。点灯は押し出しが戻ってきたときに引き直る。
  private write(key: GraphicsOptionKey, value: boolean | ChoiceValue): void {
    this.graphics.setOption(key, value);
  }

  // 各コントロールの点灯を現在の設定値へ合わせる。プリセットはどれとも一致しなければ全消灯。
  private sync(): void {
    const data = this.graphics.current;
    this.preset.setSelected(this.graphics.matchingPreset());
    for (const control of this.controls) control.show(data[control.key]);
  }
}
