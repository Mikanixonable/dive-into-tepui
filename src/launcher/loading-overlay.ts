// WebGPU 初期化や天体暦の構築など、しばらく無反応になり得る処理の間に表示するローディング画面。
// showLoading/hideLoading の対で開閉し、表示中かどうかはこのモジュール自身が持つ。
import { FONT_FAMILY, FONT_2XL, FONT_M, Z_LOADING_OVERLAY } from '../theme';

const GAUGE_SIZE = 72;
const GAUGE_THICKNESS = 6;

let overlay: HTMLElement | null = null;
let gauge: HTMLElement | null = null;
let percentText: HTMLElement | null = null;
let noteText: HTMLElement | null = null;

// 進捗 ratio(0..1)ぶんを扇形に塗った円の background 指定。
function gaugeBackground(ratio: number): string {
  const deg = Math.max(0, Math.min(1, ratio)) * 360;
  return `conic-gradient(var(--color-primary) ${deg}deg, var(--surface-opaque) 0)`;
}

// ローディング表示を出す。既に出ていれば何もしない。進捗は 0% から始まる。
export function showLoading(): void {
  if (overlay) return;
  const div = document.createElement('div');
  div.style.cssText =
    'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
    `gap:14px;color:var(--text);background:var(--bg);font-family:${FONT_FAMILY};z-index:${Z_LOADING_OVERLAY};text-align:center`;
  div.innerHTML =
    `<div style="font-size:${FONT_2XL};letter-spacing:6px;color:var(--color-primary)">Dive into Tepui</div>` +
    `<div style="position:relative;width:${GAUGE_SIZE}px;height:${GAUGE_SIZE}px;border-radius:50%;` +
    `background:${gaugeBackground(0)}">` +
    `<div style="position:absolute;inset:${GAUGE_THICKNESS}px;border-radius:50%;background:var(--bg);` +
    `display:flex;align-items:center;justify-content:center;font-size:${FONT_M};color:var(--text)">0%</div>` +
    `</div>` +
    `<div style="font-size:${FONT_M};color:var(--text-dim)">初期化中(WebGPU)…</div>`;
  document.body.appendChild(div);
  // 進捗で書き換える要素を控える。
  overlay = div;
  gauge = div.children[1] as HTMLElement;
  percentText = gauge.firstElementChild as HTMLElement;
  noteText = div.children[2] as HTMLElement;
}

// 進捗(0..1)を円形ゲージへ、note をゲージ下の注記へ反映する。表示中でなければ何もしない。
export function setLoadingProgress(ratio: number, note?: string): void {
  if (!gauge || !percentText) return;
  const clamped = Math.max(0, Math.min(1, ratio));
  gauge.style.background = gaugeBackground(clamped);
  percentText.textContent = `${Math.round(clamped * 100)}%`;
  if (noteText && note !== undefined) noteText.textContent = note;
}

// ローディング表示を片付ける。出ていなければ何もしない。
export function hideLoading(): void {
  overlay?.remove();
  overlay = null;
  gauge = null;
  percentText = null;
  noteText = null;
}
