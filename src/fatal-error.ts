// 初期化中・実行中を問わず、継続不能な例外は画面内で明示する。
// 壊れた Game/renderer を同一ページ内で再利用せず、復旧はページ全体の再読込だけにする。
import {
  ACCENT, SURFACE_OPAQUE, EDGE, BG, TEXT, TEXT_DIM, FONT_FAMILY, FONT_M, FONT_XL, RADIUS_S, RADIUS_M,
} from './game/theme';
import { hideLoading } from './loading-overlay';

// title/message/error から画面全体のオーバーレイを組み立てて表示する。既に出ていれば何もしない。
export function showFatalError(title: string, message: string, error: unknown): void {
  hideLoading();
  if (document.getElementById('fatal-error-overlay')) return;

  // 画面全体を覆う背景と、その中央に置く本体パネル。
  const overlay = document.createElement('div');
  overlay.id = 'fatal-error-overlay';
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.style.cssText =
    'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:20px;' +
    `color:${TEXT};background:${BG};font-family:${FONT_FAMILY};font-size:${FONT_XL};text-align:center;line-height:2;z-index:1000`;

  const panel = document.createElement('div');
  panel.style.cssText =
    `max-width:680px;background:${SURFACE_OPAQUE};border:1px solid ${EDGE};border-radius:${RADIUS_M};padding:22px 32px`;

  // 見出し・本文メッセージ・例外の詳細を上から順に積む。
  const heading = document.createElement('div');
  heading.style.color = ACCENT;
  heading.textContent = title;
  panel.appendChild(heading);

  const description = document.createElement('div');
  description.textContent = message;
  panel.appendChild(description);

  const detail = document.createElement('div');
  detail.style.cssText = `color:${TEXT_DIM};font-size:${FONT_M};overflow-wrap:anywhere`;
  detail.textContent = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  panel.appendChild(detail);

  // 唯一の操作: ページを再読み込みする。
  const reload = document.createElement('button');
  reload.type = 'button';
  reload.style.cssText =
    `margin-top:14px;padding:8px 18px;color:${TEXT};background:${BG};border:1px solid ${ACCENT};` +
    `border-radius:${RADIUS_S};font:inherit;cursor:pointer`;
  reload.textContent = 'ページを再読み込み';
  reload.addEventListener('click', () => location.reload());
  panel.appendChild(reload);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  reload.focus();
}
