// WebGPU 初期化や天体暦の構築など、しばらく無反応になり得る処理の間に表示するローディング画面。
// showLoading/hideLoading の対で開閉し、表示中かどうかはこのモジュール自身が持つ。
// 円形ゲージは実進捗(0..1)だけを表示する——取得できないフェーズは 0% のまま完了直前まで待つ。
import {
  ACCENT, SURFACE_OPAQUE, BG, TEXT, TEXT_DIM, FONT_FAMILY, FONT_2XL, FONT_M,
} from './game/theme';

const GAUGE_SIZE = 72;
const GAUGE_THICKNESS = 6;

let overlay: HTMLElement | null = null;
let gauge: HTMLElement | null = null;
let percentText: HTMLElement | null = null;

function gaugeBackground(ratio: number): string {
  const deg = Math.max(0, Math.min(1, ratio)) * 360;
  return `conic-gradient(${ACCENT} ${deg}deg, ${SURFACE_OPAQUE} 0)`;
}

// ローディング表示を出す。既に出ていれば何もしない。進捗は 0% から始まる。
export function showLoading(): void {
  if (overlay) return;
  const div = document.createElement('div');
  div.style.cssText =
    'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
    `gap:14px;color:${TEXT};background:${BG};font-family:${FONT_FAMILY};z-index:200;text-align:center`;
  div.innerHTML =
    `<div style="font-size:${FONT_2XL};letter-spacing:6px;color:${ACCENT}">Dive into Tepui</div>` +
    `<div style="position:relative;width:${GAUGE_SIZE}px;height:${GAUGE_SIZE}px;border-radius:50%;` +
    `background:${gaugeBackground(0)}">` +
    `<div style="position:absolute;inset:${GAUGE_THICKNESS}px;border-radius:50%;background:${BG};` +
    `display:flex;align-items:center;justify-content:center;font-size:${FONT_M};color:${TEXT}">0%</div>` +
    `</div>` +
    `<div style="font-size:${FONT_M};color:${TEXT_DIM}">初期化中(WebGPU)…</div>`;
  document.body.appendChild(div);
  overlay = div;
  gauge = div.children[1] as HTMLElement;
  percentText = gauge.firstElementChild as HTMLElement;
}

// 進捗(0..1)を円形ゲージへ反映する。表示中でなければ何もしない。
export function setLoadingProgress(ratio: number): void {
  if (!gauge || !percentText) return;
  const clamped = Math.max(0, Math.min(1, ratio));
  gauge.style.background = gaugeBackground(clamped);
  percentText.textContent = `${Math.round(clamped * 100)}%`;
}

// ローディング表示を片付ける。出ていなければ何もしない。
export function hideLoading(): void {
  overlay?.remove();
  overlay = null;
  gauge = null;
  percentText = null;
}
