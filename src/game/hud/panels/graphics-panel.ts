// 設定メニューの「描画」面。品質プリセットと、描画品質設定の全項目を群ごとに並べる。
// **項目の増減にこのファイルは追随しない** — 並びも見出しも設定側の表が決める。
import {
  GRAPHICS_GROUPS, GRAPHICS_OPTIONS, GraphicsSettings, graphicsOptionKeys,
  type GraphicsOptionKey, type QualityPreset,
} from '../../../render/graphics-settings';
import { SegmentedControl, ToggleSwitch } from '../widgets';

const PRESET_ITEMS: readonly (readonly [QualityPreset, string])[] = [
  ['low', '低'], ['medium', '中'], ['high', '高'],
];

// 項目1つぶんのコントロール。sync() が現在値から点灯を引き直すために持つ。
type OptionControl =
  | { readonly kind: 'toggle'; readonly key: GraphicsOptionKey; readonly widget: ToggleSwitch }
  | { readonly kind: 'choice'; readonly key: GraphicsOptionKey; readonly widget: SegmentedControl<number> };

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

  // 項目1つぶんのコントロールを組んで節へ並べる。選択肢はセグメントコントロール、真偽は
  // トグルスイッチ — 2値の ON/OFF にセグメントコントロールを使わない。
  private addControl(section: HTMLElement, key: GraphicsOptionKey): OptionControl {
    const option = GRAPHICS_OPTIONS[key];
    // 種別で組み立てが分かれるので、返り値も種別つきで返して点灯の引き直しを一意にする。
    if (option.kind === 'toggle') {
      const widget = new ToggleSwitch(option.label, (on) => {
        this.graphics.setOption(key, on);
        this.sync();
      });
      section.appendChild(widget.element);
      return { kind: 'toggle', key, widget };
    }
    const widget = new SegmentedControl<number>(option.label, option.items, (value) => {
      this.graphics.setOption(key, value);
      this.sync();
    });
    section.appendChild(widget.element);
    return { kind: 'choice', key, widget };
  }

  // 各コントロールの点灯を現在の設定値へ合わせる。プリセットはどれとも一致しなければ全消灯。
  private sync(): void {
    const data = this.graphics.current;
    this.preset.setSelected(this.graphics.matchingPreset());
    for (const control of this.controls) {
      const value = data[control.key];
      if (control.kind === 'toggle') control.widget.setOn(value === true);
      else control.widget.setSelected(typeof value === 'number' ? value : null);
    }
  }
}
