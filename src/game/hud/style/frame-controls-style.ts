// 座標系・カメラ FOV/角度操作パネル(.hud-frame-controls)の CSS。
export const FRAME_CONTROLS_STYLE = `
#hud .hud-frame-controls {
  width: 100%; pointer-events: auto;
  max-height: none; overflow: visible;
}
/* 座標系の候補が増えても、見出しの右側へボタンを押し出さない。 */
#hud .hud-frame-controls .hud-frame-origin-zone > .w-group:first-child > .w-group-title,
#hud .hud-frame-controls .hud-frame-rotation-zone > .w-group-title {
  flex: 0 0 100%; min-width: 0;
}
/* タイトルを独立行にし、次の行へスライダー・数値入力・リセットボタンを並べる。 */
#hud .hud-frame-controls .camera-fov-control {
  display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-3);
}
#hud .hud-frame-controls .camera-control-label {
  flex: 0 0 100%; color: var(--text-dim); font-size: var(--font-xs); letter-spacing: var(--tracking-label);
}
#hud .hud-frame-controls .camera-fov-control .w-slider { flex: 1 1 auto; min-width: 60px; }
#hud .hud-frame-controls .camera-fov-control .w-slider:disabled,
#hud .hud-frame-controls .camera-fov-control .w-input:disabled { opacity: .4; cursor: not-allowed; }
#hud .hud-frame-controls .camera-fov-control .w-input { width: 54px; }
#hud .hud-frame-controls .camera-control-unit { color: var(--text-dim); font-size: var(--font-xs); }
#hud .hud-frame-controls .camera-fov-note {
  flex: 0 0 100%; color: var(--text-dim); font-size: var(--font-xxs); line-height: 1.45;
}
/* 「角度」プルダウン: 見出しを独立行にし、次の行へ選択欄とセットボタンを並べる。 */
#hud .hud-frame-controls .camera-angle-group > .w-group-title { flex: 0 0 100%; min-width: 0; }
#hud .hud-frame-controls .camera-angle-group .w-select { flex: 1 1 auto; min-width: 80px; }

/* CAMERA / FRAME — 現在状態を先に読み、操作は下段へ分離する。 */
#hud .hud-frame-controls .editorial-panel-head { margin-bottom: var(--space-3); }
#hud .hud-frame-controls .editorial-state { margin-top: var(--space-1); }
#hud .hud-frame-controls .camera-state-lens {
  display: grid; grid-template-columns: minmax(0, .8fr) minmax(0, 1.2fr);
  align-items: end; gap: var(--space-3);
}
#hud .hud-frame-controls .camera-state-lens > div { display: grid; gap: var(--space-1); min-width: 0; }
#hud .hud-frame-controls .camera-state-lens > div:last-child { text-align: right; }
#hud .hud-frame-controls .camera-state-lens .ui-data-hero { font-size: var(--font-2xl); }
#hud .hud-frame-controls .editorial-control-zone > :last-child { margin-bottom: 0; }
#hud .hud-frame-controls-compact {
  max-height: none; overflow: visible;
}
#hud .hud-frame-controls-compact .editorial-panel-head { margin-bottom: var(--space-2); }
#hud .trajectory-frame-state [data-frame-hero="true"] {
  text-transform: uppercase;
}
`;
