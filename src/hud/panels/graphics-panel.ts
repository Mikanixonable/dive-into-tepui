// 設定メニューの「描画」面。品質プリセットと、描画品質設定の全項目を群ごとに並べる。
// 並びも見出しも GRAPHICS_GROUPS・GRAPHICS_OPTIONS の表からそのまま組む。
// 表示中の設定値一式を持ち、操作のたびに新しい一式を組み立てて onChange で外へ返す。
import {
  GRAPHICS_GROUPS, GRAPHICS_OPTIONS, QUALITY_PRESETS, graphicsOptionKeys, matchingGraphicsPreset, withGraphicsOption,
  type ChoiceValue, type GraphicsOptionKey, type GraphicsSettingsData, type QualityPreset,
} from '../../render/graphics-settings';
import { Pulldown, SegmentedControl, ToggleSwitch, type PulldownColumn } from '../widgets';
import { MQ_COMPACT } from '../breakpoints';
import { injectOnce } from '../inject-style';

// このパネル自身の CSS。余白を持つ規則は `#hud` を冠した枝を併記する — HUD は `#hud, #hud *` で
// margin/padding を 0 へ落としており、素のクラス 1 つでは詳細度で負けて群の間隔が潰れる。
const STYLE = `
.gp-body, #hud .gp-body {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4) var(--space-5); margin-top: var(--space-4); min-width: 0;
}
.gp-body > .w-group { grid-column: 1 / -1; min-width: 0; }
.gp-group, #hud .gp-group {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: var(--space-3); row-gap: var(--space-3);
  align-items: start; min-width: 0; padding-top: var(--space-4);
}
.gp-group-title { grid-column: 1 / -1;
  margin: 0; color: var(--color-primary); font-size: var(--font-xxs); letter-spacing: 0.12em;
}
.gp-group > .w-group, .gp-group > .w-toggle { min-width: 0; }
@media ${MQ_COMPACT} {
  .gp-body, #hud .gp-body { grid-template-columns: 1fr; }
  .gp-group, #hud .gp-group { grid-template-columns: 1fr; }
}
`;

const PRESET_ITEMS: readonly (readonly [QualityPreset, string])[] = [
  ['low', '低'], ['medium', '中'], ['high', '高'],
];

// hidden の既定。全項目を並べる。
const NO_HIDDEN_KEYS: ReadonlySet<GraphicsOptionKey> = new Set();

// プルダウンで選ぶ項目の列。描画設定の項目はどれも1列しか持たない。
type SelectColumns = readonly [PulldownColumn<ChoiceValue>];

// 項目1つぶんのコントロール。現在値から点灯を引き直す口だけを持つ。
interface OptionControl {
  readonly key: GraphicsOptionKey;
  readonly show: (value: boolean | ChoiceValue) => void;
}

export class GraphicsPanel {
  public readonly element: HTMLElement;

  // 操作で新しい設定値一式ができたときに呼ばれる。
  public onChange: ((graphics: GraphicsSettingsData) => void) | null = null;

  private readonly preset: SegmentedControl<QualityPreset>;
  private readonly controls: readonly OptionControl[];

  // graphics は組み立て時に点灯させる設定値。hidden は伏せる項目(この置き場では切り替えても
  // 効かないもの)で、項目の無くなった群は見出しごと消える。
  public constructor(
    private graphics: GraphicsSettingsData,
    hidden: ReadonlySet<GraphicsOptionKey> = NO_HIDDEN_KEYS,
  ) {
    injectOnce('graphics-panel', STYLE);
    this.element = document.createElement('div');
    this.element.className = 'gp-body';

    this.preset = new SegmentedControl('品質プリセット', PRESET_ITEMS, (preset) => {
      this.select(QUALITY_PRESETS[preset]);
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

    // 引き直す先が揃ってから点灯させる。
    this.sync(graphics);
  }

  // 外から設定値が変わったときに、全コントロールの点灯を引き直す。プリセットはどれとも
  // 一致しなければ全消灯。
  public sync(graphics: GraphicsSettingsData): void {
    this.graphics = graphics;
    this.preset.setSelected(matchingGraphicsPreset(graphics));
    for (const control of this.controls) control.show(graphics[control.key]);
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

  // 項目1つを差し替えた設定値一式へ移る。
  private write(key: GraphicsOptionKey, value: boolean | ChoiceValue): void {
    this.select(withGraphicsOption(this.graphics, key, value));
  }

  // 選ばれた設定値一式へ移る。自分の点灯を引き直してから外へ返す。
  private select(graphics: GraphicsSettingsData): void {
    this.sync(graphics);
    this.onChange?.(graphics);
  }
}
