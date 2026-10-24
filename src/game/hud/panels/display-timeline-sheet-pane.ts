// シートの「時間」の面。スマホ横持ち(レールの無い幅)では、時間軸の端や「⋯」から開く小窓の代わりに、
// 表示範囲の選択と目盛り・凡例の設定の部品をこの面へ載せる。部品は複製せず、小窓の本体とこの面の間を
// 画面の幅に合わせて付け替える。面そのものはレール上のパネルで、シートがタブに選んだときだけ CSS が出す。
import { hudRail } from '../hud-root';
import { MQ_COARSE_SHORT } from '../../../hud/breakpoints';
import type { TimelinePopover } from './display-timeline-popover';

// 小窓1つぶんの部品。小窓の中身とこの面の1区画を行き来する。
interface PopoverParts {
  readonly popover: TimelinePopover;
  readonly parts: readonly HTMLElement[];
  // この面で区画の先頭に置く小見出し。
  readonly heading: string;
}

export class TimelineSheetPane {
  private readonly body: HTMLElement;
  private readonly media: MediaQueryList | null;

  // root(マップの HUD ルート)の右レールへ面を足し、いまの幅に合わせて部品を置く。
  public constructor(root: HTMLElement, private readonly range: PopoverParts, private readonly settings: PopoverParts) {
    // 面は右レールの1パネル。見出しの無い本体だけを持ち、並びはシートの CSS が列へ流す。
    const pane = document.createElement('div');
    pane.id = 'hud-time-pane';
    pane.className = 'panel';
    pane.setAttribute('aria-label', '時間');
    pane.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.body = document.createElement('div');
    this.body.className = 'panel-shell-body';
    pane.appendChild(this.body);
    hudRail(root, 'right').appendChild(pane);
    this.media = typeof matchMedia === 'function' ? matchMedia(MQ_COARSE_SHORT) : null;
    this.media?.addEventListener('change', this.handleMediaChange);
    this.host(this.media?.matches ?? false);
  }

  // 部品を、この面(inSheet)か、元の小窓へ置く。
  private host(inSheet: boolean): void {
    if (inSheet) {
      this.range.popover.close();
      this.settings.popover.close();
      this.body.replaceChildren(...this.section(this.range), ...this.section(this.settings));
    } else {
      this.range.popover.body.append(...this.range.parts);
      this.settings.popover.body.append(...this.settings.parts);
    }
  }

  // 小見出しと部品の並び。
  private section({ heading, parts }: PopoverParts): HTMLElement[] {
    const title = document.createElement('div');
    title.className = 'ui-sub';
    title.textContent = heading;
    return [title, ...parts];
  }

  // レールの無い幅への出入りに合わせて、部品の置き場を付け替える。
  private readonly handleMediaChange = (event: MediaQueryListEvent): void => this.host(event.matches);

  // 幅の監視をやめ、面を取り除く。
  public dispose(): void {
    this.media?.removeEventListener('change', this.handleMediaChange);
    this.body.parentElement?.remove();
  }
}
