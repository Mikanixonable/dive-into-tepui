// HUD とタイトル画面が共有する、ガラス面・選択状態・計器の表示部品の共通スタイル。
// 画面固有の CSS は配置と内容の調整だけを持ち、UI の面と状態はここへ集約する。
import { injectOnce } from '../inject-style';
import { WIDGET_STYLE } from '../widgets/widget-style';
import { HUD_LAYOUT_TOKENS_STYLE } from './layout-tokens';
import { INSTRUMENT_STYLE } from './instrument-style';

// 描画品質設定で UI の背景ぼかしを切ったときにルート要素へ付けるクラス。付いている間は、ガラス面を
// 背景ぼかし非対応のブラウザと同じ不透明な面で描く。
export const UI_BLUR_OFF_CLASS = 'ui-blur-off';

// 背景ぼかしを持つ面のうち、ぼかしが無いときに不透明な面へ替えるものを選ぶセレクタ group から、
// 非対応のブラウザとぼかしを切ったときの両方で効く規則を組む。
export function opaqueGlassFallbackStyle(group: string): string {
  return `
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  ${group} { background: var(--surface-opaque); }
}
:root.${UI_BLUR_OFF_CLASS} :is(${group}) {
  background: var(--surface-opaque);
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}
`;
}

// UI の背景ぼかしを描くかを切り替える。切ると全画面のガラス面が不透明な面になる。
export function setUiBackdropBlur(enabled: boolean): void {
  document.documentElement.classList.toggle(UI_BLUR_OFF_CLASS, !enabled);
}

const SURFACE_STYLE = `
.ui-surface-quiet, #hud .panel {
  background: var(--glass-quiet);
  border-radius: var(--radius-panel);
  box-shadow: var(--glass-shadow);
  backdrop-filter: blur(var(--glass-blur-quiet)) saturate(var(--glass-saturation));
  -webkit-backdrop-filter: blur(var(--glass-blur-quiet)) saturate(var(--glass-saturation));
}
#hud .ui-surface-focus, .ui-surface-focus {
  background: var(--glass-focus);
  border-radius: var(--radius-panel);
  box-shadow: var(--glass-shadow);
  backdrop-filter: blur(var(--glass-blur-focus)) saturate(var(--glass-saturation));
  -webkit-backdrop-filter: blur(var(--glass-blur-focus)) saturate(var(--glass-saturation));
}
.ui-surface-inset {
  background: var(--glass-inset);
  border-radius: var(--radius-control);
}
.ui-selectable {
  transition: color var(--transition-fast), background var(--transition-fast), transform var(--transition-fast);
}
.ui-selectable:hover {
  background: var(--glass-control-hover);
  color: var(--color-primary-hover);
}
.ui-selectable.on {
  background: var(--color-primary-fill);
  color: var(--color-primary);
}
.ui-selectable.pressed {
  background: var(--fill-3);
  transform: translateY(1px);
}
.ui-selectable.disabled {
  opacity: 0.35;
  cursor: not-allowed;
  pointer-events: none;
}

/* 警告・エラー・補足メッセージの面だけを共通化する。配置(margin/width)は各画面が持つ。 */
.ui-status-note {
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-micro);
  font-size: var(--font-s);
  line-height: 1.45;
}
.ui-status-note--info {
  color: var(--color-primary);
  background: var(--color-primary-fill-weak);
}
.ui-status-note--warning {
  color: var(--color-warning);
  background: var(--color-warning-fill);
}
.ui-status-note--danger {
  color: var(--color-error);
  background: var(--color-error-fill);
}
${opaqueGlassFallbackStyle('.ui-surface-quiet, #hud .panel, #hud .ui-surface-focus, .ui-surface-focus')}`;

// 共通 UI の CSS を一度だけ document.head へ注入する。
export function injectCommonUiStyle(): void {
  injectOnce('common-ui-style', HUD_LAYOUT_TOKENS_STYLE + SURFACE_STYLE + INSTRUMENT_STYLE + WIDGET_STYLE);
}
