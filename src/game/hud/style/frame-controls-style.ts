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
/* 画角の行: [ラベル] [スライダー] [数値] [単位] [リセット]。 */
#hud .hud-frame-controls .camera-fov-control {
  display: grid; grid-template-columns: minmax(var(--instrument-label-min), max-content) minmax(0, 1fr) auto auto auto;
  align-items: center; column-gap: var(--space-3); min-height: var(--row-min-h-s); margin: 0;
}
#hud .hud-frame-controls .camera-control-label { color: var(--role-label); font-size: var(--font-xs); }
#hud .hud-frame-controls .camera-fov-control .w-slider { min-width: 0; width: 100%; }
#hud .hud-frame-controls .camera-fov-control .w-slider:disabled,
#hud .hud-frame-controls .camera-fov-control .w-input:disabled { opacity: .4; cursor: not-allowed; }
#hud .hud-frame-controls .camera-fov-control .w-input { width: 54px; }
#hud .hud-frame-controls .camera-control-unit { color: var(--role-label); font-size: var(--font-xs); }
#hud .hud-frame-controls .camera-fov-note {
  grid-column: 1 / -1; color: var(--role-label); font-size: var(--font-xxs); line-height: 1.45;
}
/* 切り替えの行は、行の文法(ラベルと値を両端へ)に揃える。 */
#hud .hud-frame-controls .camera-rows > .w-toggle {
  justify-content: space-between; min-height: var(--row-min-h-s); margin: 0;
}
#hud .hud-frame-controls .camera-rows .w-toggle-title { color: var(--role-label); font-size: var(--font-xs); letter-spacing: 0; }
#hud .hud-frame-controls .ui-ident { margin-bottom: var(--space-3); }
/* カメラパネルの選択行は、見出しを横に置いてボタンを小さく詰める。 */
#hud #hud-camera-controls .w-group { gap: var(--space-2); margin: var(--space-3) 0 0; }
#hud #hud-camera-controls .w-group-title { min-width: 0; margin-right: var(--space-2); }
#hud #hud-camera-controls .w-group .w-btn { padding: var(--space-2) var(--space-3); font-size: var(--font-xxs); }
#hud #hud-camera-controls .hud-anchor-zone { margin-top: var(--space-3); }
#hud #hud-camera-controls .hud-anchor-zone .w-group { margin: 0; }
#hud #hud-camera-controls .camera-angle-group { flex-wrap: nowrap; }
#hud #hud-camera-controls .camera-angle-group .w-select { flex: 1 1 0; min-width: 0; }

#hud .hud-frame-controls .editorial-control-zone > :last-child { margin-bottom: 0; }
#hud .hud-frame-controls-compact {
  max-height: none; overflow: visible;
}
#hud .hud-frame-controls-compact .editorial-panel-head { margin-bottom: var(--space-2); }
/* 戦闘のカメラパネルのトグルは [見出し][トラック][キー] の行で、トラックとキーが行をまたいで揃う。 */
#hud .hud-frame-controls-compact .w-toggle {
  display: grid; grid-template-columns: minmax(0, 1fr) auto var(--instrument-key-col);
  column-gap: var(--space-4); align-items: center; min-height: var(--row-min-h-s);
}
#hud .hud-frame-controls-compact .w-toggle-title { font-size: var(--font-xs); color: var(--role-label); }
#hud .hud-frame-controls-compact .w-toggle > .ui-key { justify-self: end; }
#hud .trajectory-frame-state [data-frame-hero="true"] {
  text-transform: uppercase;
}
`;
