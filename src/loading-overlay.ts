// WebGPU 初期化や天体暦の構築など、しばらく無反応になり得る処理の間に表示するローディング画面。
// showLoading/hideLoading の対で開閉し、表示中かどうかはこのモジュール自身が持つ。
import {
  ACCENT, SURFACE_OPAQUE, BG, TEXT, TEXT_DIM, FONT_FAMILY, FONT_2XL, FONT_M,
} from './game/theme';

let overlay: HTMLElement | null = null;
let style: HTMLElement | null = null;

// ローディング表示を出す。既に出ていれば何もしない。
export function showLoading(): void {
  if (overlay) return;
  const div = document.createElement('div');
  div.style.cssText =
    'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
    `gap:14px;color:${TEXT};background:${BG};font-family:${FONT_FAMILY};z-index:200;text-align:center`;
  div.innerHTML =
    `<div style="font-size:${FONT_2XL};letter-spacing:6px;color:${ACCENT}">Dive into Tepui</div>` +
    `<div style="width:40px;height:40px;border-radius:50%;border:3px solid ${SURFACE_OPAQUE};` +
    `border-top-color:${ACCENT};animation:tepui-spin 0.9s linear infinite"></div>` +
    `<div style="font-size:${FONT_M};color:${TEXT_DIM}">初期化中(WebGPU)…</div>`;
  const s = document.createElement('style');
  s.textContent = '@keyframes tepui-spin { to { transform: rotate(360deg); } }';
  document.head.appendChild(s);
  document.body.appendChild(div);
  overlay = div;
  style = s;
}

// ローディング表示を片付ける。出ていなければ何もしない。
export function hideLoading(): void {
  overlay?.remove();
  style?.remove();
  overlay = null;
  style = null;
}
