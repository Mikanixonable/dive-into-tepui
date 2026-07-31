// 画面座標に絶対配置する汎用コンテキストメニュー。右クリックで開き、項目クリックで
// onSelect(act) を発火して自動で閉じる。
import { ACCENT_RGB, ACCENT_SOFT, TEXT as INK } from '../theme';

const SURFACE = 'rgba(13, 15, 18, 0.85)';
const EDGE = 'rgba(255, 255, 255, 0.16)';

const STYLE = `
.ctx-menu {
  position: fixed; display: none; min-width: 168px; z-index: 9;
  pointer-events: auto; background: ${SURFACE}; border: 1px solid ${EDGE};
  border-radius: 4px; overflow: hidden; font-size: 12px;
  font-family: 'Consolas', 'Courier New', monospace; user-select: none;
  -webkit-user-select: none;
}
.ctx-menu-item {
  padding: 9px 14px; color: ${INK}; cursor: pointer; border-bottom: 1px solid ${EDGE};
}
.ctx-menu-item:last-child { border-bottom: none; }
.ctx-menu-item:hover, .ctx-menu-item:active {
  background: rgba(${ACCENT_RGB}, 0.18); color: ${ACCENT_SOFT};
}
`;

let styleInjected = false;
function ensureStyle(): void {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
}

export interface MenuItem {
  label: string;
  act: string;
}

export class ContextMenu {
  private readonly el: HTMLDivElement;
  onSelect: ((act: string) => void) | null = null;

  constructor() {
    ensureStyle();
    this.el = document.createElement('div');
    this.el.className = 'ctx-menu';
    document.body.appendChild(this.el);
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    // キャプチャ段階で拾うことで、途中の要素が stopPropagation していても届く。
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (e.target instanceof Node && this.el.contains(e.target)) return;
        this.close();
      },
      true,
    );
  }

  open(clientX: number, clientY: number, items: MenuItem[]): void {
    this.el.innerHTML = items
      .map((it) => `<div class="ctx-menu-item" data-act="${it.act}">${it.label}</div>`)
      .join('');
    this.el.querySelectorAll<HTMLElement>('.ctx-menu-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = item.dataset['act'] ?? '';
        this.close();
        this.onSelect?.(act);
      });
    });
    this.el.style.left = `${clientX}px`;
    this.el.style.top = `${clientY}px`;
    this.el.style.display = 'block';
  }

  close(): void {
    this.el.style.display = 'none';
  }
}
