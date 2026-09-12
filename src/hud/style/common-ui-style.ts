// HUD とタイトル画面が共有する、ガラス面と選択状態の共通スタイル。
// 画面固有の CSS は配置と内容の調整だけを持ち、UI の面と状態はここへ集約する。
import { injectOnce } from '../inject-style';
import { WIDGET_STYLE } from '../widgets/widget-style';

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

@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .ui-surface-quiet, #hud .panel, #hud .ui-surface-focus, .ui-surface-focus { background: var(--surface-opaque); }
}
`;

// 共通 UI の CSS を一度だけ document.head へ注入する。
export function injectCommonUiStyle(): void {
  injectOnce('common-ui-style', SURFACE_STYLE + WIDGET_STYLE);
}
