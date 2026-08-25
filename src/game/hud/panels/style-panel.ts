// スタイルパネル(左レール、戦闘・マップ共通): 画面全体の見せ方(写実/模式図)を1つ選ぶ。
// RENDER_STYLES を縦並びの単一選択として出し、選択を RenderStyleSetting.set() へ書く。
// 選択状態の正本は RenderStyleSetting 側にあり、このパネルは subscribe() で追従するだけ。
import { RENDER_STYLES, type RenderStyle, type RenderStyleSetting } from '../../../render/render-style';
import { PanelShell } from '../panel-shell';
import { Button } from '../widgets';

export class StylePanel {
  readonly panel: PanelShell;
  private readonly buttons: ReadonlyMap<RenderStyle, Button>;

  // parent(左レール)へパネルを組み込み、renderStyle の現在値と変更を追従する。
  constructor(parent: HTMLElement, renderStyle: RenderStyleSetting) {
    this.panel = new PanelShell(parent, 'hud-style', 'スタイル');

    const list = document.createElement('div');
    list.className = 'style-panel-list';
    list.setAttribute('role', 'radiogroup');
    list.setAttribute('aria-label', '画面全体の見せ方');

    const buttons = new Map<RenderStyle, Button>();
    for (const [style, label] of RENDER_STYLES) {
      const button = new Button(label, () => renderStyle.set(style));
      button.element.classList.add('style-panel-option');
      // 排他選択の1項目として振る舞う。Button 既定の aria-pressed は使わず aria-checked に一本化する。
      button.element.setAttribute('role', 'radio');
      button.element.removeAttribute('aria-pressed');
      list.appendChild(button.element);
      buttons.set(style, button);
    }
    this.buttons = buttons;
    this.panel.body.appendChild(list);

    renderStyle.subscribe((style) => this.syncSelection(style));
  }

  // 選択中の style だけを点灯させる。
  private syncSelection(style: RenderStyle): void {
    for (const [value, button] of this.buttons) {
      const selected = value === style;
      button.setOn(selected);
      button.element.removeAttribute('aria-pressed');
      button.element.setAttribute('aria-checked', String(selected));
    }
  }
}
