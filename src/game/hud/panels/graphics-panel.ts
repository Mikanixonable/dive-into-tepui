// 設定メニューの「描画」面。品質プリセットと、描画品質設定の全項目を群ごとに並べる。
// 並びも見出しも GRAPHICS_GROUPS・GRAPHICS_OPTIONS の表からそのまま組む。
import {
  GRAPHICS_GROUPS, GRAPHICS_OPTIONS, GraphicsSettings, graphicsOptionKeys,
  type ChoiceValue, type GraphicsOptionKey, type QualityPreset,
} from '../../../render/graphics-settings';
import { Pulldown, SegmentedControl, ToggleSwitch, type PulldownColumn } from '../widgets';

const PRESET_ITEMS: readonly (readonly [QualityPreset, string])[] = [
  ['low', '低'], ['medium', '中'], ['high', '高'],
];

// プルダウンで選ぶ項目の列。描画設定の項目はどれも1列しか持たない。
type SelectColumns = readonly [PulldownColumn<ChoiceValue>];

// 項目1つぶんのコントロール。現在値から点灯を引き直す口だけを持つ。
interface OptionControl {
  readonly key: GraphicsOptionKey;
  readonly show: (value: boolean | ChoiceValue) => void;
}

export class GraphicsPanel {
  public readonly element: HTMLElement;

  private readonly preset: SegmentedControl<QualityPreset>;
  private readonly controls: readonly OptionControl[];

  // プリセットの列を先頭へ置き、続けて群ごとの節を並べる。どの操作も graphics へ書いてから
  // sync() で全コントロールの点灯を引き直すので、点灯の正本は常にそちら側にある。
  public constructor(private readonly graphics: GraphicsSettings) {
    this.element = document.createElement('div');
    this.element.className = 'gp-body';

    this.preset = new SegmentedControl('品質プリセット', PRESET_ITEMS, (preset) => {
      this.graphics.applyPreset(preset);
      this.sync();
    });
    this.element.appendChild(this.preset.element);

    // 空の群は見出しごと出さない。
    const controls: OptionControl[] = [];
    for (const [group, title] of GRAPHICS_GROUPS) {
      const keys = graphicsOptionKeys(group);
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

  // 項目1つを書き換えてから、全コントロールの点灯を引き直す。
  private write(key: GraphicsOptionKey, value: boolean | ChoiceValue): void {
    this.graphics.setOption(key, value);
    this.sync();
  }

  // 各コントロールの点灯を現在の設定値へ合わせる。プリセットはどれとも一致しなければ全消灯。
  private sync(): void {
    const data = this.graphics.current;
    this.preset.setSelected(this.graphics.matchingPreset());
    for (const control of this.controls) control.show(data[control.key]);
  }
}
