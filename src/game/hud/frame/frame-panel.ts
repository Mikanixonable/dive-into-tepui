// 座標系パネルの外枠を組む。見出しを持つパネルを左レールへ足し、中身を入れる要素を返す。
import { hudRail } from '../hud-root';

// id と見出しを持つパネルを左レールへ立てて返す。パネル上のポインタ操作は下へ抜けない。
export function buildPanel(root: HTMLElement, id: string, titleText: string, code: string): HTMLElement {
  const panel = document.createElement('div');
  panel.id = id;
  panel.className = 'panel hud-frame-controls editorial-control-sheet';
  panel.addEventListener('pointerdown', (e) => e.stopPropagation());

  const head = document.createElement('div');
  head.className = 'editorial-panel-head';
  const codeEl = document.createElement('span');
  codeEl.className = 'ui-section-code';
  codeEl.setAttribute('aria-hidden', 'true');
  codeEl.textContent = code;
  const title = document.createElement('h3');
  title.className = 'editorial-panel-title';
  title.textContent = titleText;
  head.append(codeEl, title);
  panel.appendChild(head);

  hudRail(root, 'left').appendChild(panel);
  return panel;
}
