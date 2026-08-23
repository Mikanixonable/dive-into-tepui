// HUD の固定バッジ・ステータスバー・通知 CSS (視点バッジ、シミュレーションステータス、スケール定規、ヒント、トースト、カメラリセット)。

export const HUD_BADGE_STYLE = `
#hud-simulation-status {
  position: absolute; top: 0; left: 50%; transform: translateX(-50%);
  pointer-events: auto;
  padding: var(--space-3) var(--space-5); border-radius: 0 0 var(--radius-panel) var(--radius-panel);
  background: var(--glass-quiet); border: 0; backdrop-filter: blur(14px) saturate(82%);
  font-size: var(--font-s); letter-spacing: 1px; font-variant-numeric: tabular-nums;
  color: var(--text-dim);
  display: flex; flex-direction: column; align-items: center; gap: var(--space-2);
  max-width: calc(100vw - var(--space-6) * 2);
}
#hud-simulation-status .gs-row {
  display: flex; align-items: center; gap: var(--space-4); white-space: nowrap;
  max-width: 100%; overflow-x: auto; scrollbar-width: none;
}
#hud-simulation-status .v { color: var(--text); }
#hud-simulation-status .gs-sep { color: var(--edge); }

#hud-viewbadge {
  gap: var(--space-3);
  color: var(--text-dim); font-size: var(--font-xxs); letter-spacing: 1.2px; opacity: 0.9;
}
#hud-viewbadge .vb-title { color: var(--accent); }
#hud-viewbadge .vb-mode { color: var(--text-dim); }
#hud-viewbadge .vb-context { display: inline-flex; align-items: center; gap: var(--space-1); min-width: 0; }
#hud-viewbadge .vb-context-k { color: var(--text-dim); }
#hud-viewbadge .vb-context-v { color: var(--text); max-width: 18em; overflow: hidden; text-overflow: ellipsis; }
#hud-viewbadge .vb-sep { color: var(--edge); }
#hud-viewbadge span.vb-view-btn {
  background: var(--surface-2);
  border-radius: var(--radius-micro); padding: var(--space-1) var(--space-3);
  color: var(--text-dim); font: inherit; letter-spacing: inherit;
}
#hud-viewbadge span.vb-view-btn:hover { color: var(--text); border-color: var(--accent-soft); }

#hud-map-scale {
  position: absolute; right: 12px; bottom: 12px; display: none; pointer-events: none;
  padding: var(--space-2) var(--space-4) var(--space-3); border: 0; border-radius: var(--radius-control);
  background: var(--glass-quiet); backdrop-filter: blur(14px) saturate(82%);
  color: var(--text-dim); font-size: var(--font-xxs); line-height: 1.1;
  font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap;
}
#hud-map-scale .map-scale-value { color: var(--text); }
#hud-map-scale .map-scale-ruler { position: relative; height: 10px; margin-top: var(--space-1); margin-left: auto; }
#hud-map-scale .map-scale-ruler::before {
  content: ''; position: absolute; left: 0; right: 0; top: 5px; border-top: 1px solid var(--text-dim);
}
#hud-map-scale .map-scale-tick {
  position: absolute; top: 1px; height: 9px; border-left: 1px solid var(--text);
}
#hud-map-scale .map-scale-tick.start { left: 0; }
#hud-map-scale .map-scale-tick.q1 { left: 25%; }
#hud-map-scale .map-scale-tick.mid { left: 50%; }
#hud-map-scale .map-scale-tick.q3 { left: 75%; }
#hud-map-scale .map-scale-tick.end { right: 0; }

#hud-hint {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  background: var(--glass-focus); border: 0; border-radius: var(--radius-panel);
  padding: var(--space-4) var(--space-6);
  color: var(--accent-soft); font-size: var(--font-xl);
  box-shadow: 0 16px 48px var(--shade-1); backdrop-filter: blur(20px) saturate(82%);
  transition: opacity var(--transition-slow); opacity: 0; text-align: center;
}
#hud-chase-reset {
  position: absolute; top: 40px; left: 50%; transform: translateX(-50%);
  pointer-events: auto; cursor: pointer;
  width: 32px; height: 32px; border-radius: 50%;
  display: flex; justify-content: center; align-items: center;
  padding: 0;
  border: 0; background: var(--glass-quiet); color: var(--text-dim);
  backdrop-filter: blur(14px) saturate(82%);
}
#hud-chase-reset:hover { background: var(--surface-2); color: var(--accent-near); }
#hud-chase-reset:focus-visible { outline: 2px solid var(--accent-near); outline-offset: 2px; }

#hud-toast {
  position: absolute; top: 18%; left: 50%; transform: translateX(-50%);
  background: var(--glass-focus); border: 0; border-radius: var(--radius-panel); padding: var(--space-5) var(--space-6);
  color: var(--text); font-size: var(--font-xl); text-align: center;
  box-shadow: 0 16px 48px var(--shade-1); backdrop-filter: blur(20px) saturate(82%);
  transition: opacity var(--transition-slow); opacity: 0; line-height: 1.8;
}

#hud .sim-speed-hot { color: var(--accent); }
#hud .mode-tgt { color: var(--accent); }
#hud .warn-hot { color: var(--danger); }
`;
