// 座標系・カメラパネル(.hud-frame-controls / #hud-map-frame)の CSS。
// 色・余白・角丸・文字サイズはすべてテーマトークンから引き、リテラル値を書かない。
import { MQ_COARSE, MQ_COMPACT } from '../../../hud-kit/breakpoints';

export const FRAME_CONTROLS_STYLE = `
#hud .hud-frame-controls {
  width: 100%; pointer-events: auto;
  max-height: none; overflow: visible;
}
#hud .hud-frame-controls .editorial-panel-head {
  display: flex; align-items: center; gap: var(--space-2);
  margin-bottom: var(--space-3);
}
#hud .hud-frame-controls .editorial-panel-head .editorial-panel-title {
  margin-bottom: 0; flex: 1 1 auto; min-width: 0;
}
#hud .hud-frame-controls-compact {
  max-height: none; overflow: visible;
}
#hud .hud-frame-controls-compact .editorial-panel-head { margin-bottom: var(--space-2); }

/* 軌道連動 / 軌道分離ピル */
#hud #hud-map-frame .fc-link-pill {
  display: inline-flex; align-items: center; gap: var(--space-1);
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-pill);
  box-shadow: inset 0 0 0 1px var(--edge);
  background: var(--glass-control);
  color: var(--text-dim);
  font-size: var(--font-xxs); font-weight: 600; white-space: nowrap;
  cursor: pointer; transition: background var(--transition-fast), color var(--transition-fast), box-shadow var(--transition-fast);
}
#hud #hud-map-frame .fc-link-pill:hover { background: var(--glass-control-hover); color: var(--text); }
#hud #hud-map-frame .fc-link-pill.on {
  background: var(--role-target-fill);
  box-shadow: inset 0 0 0 1px var(--role-target-edge);
  color: var(--color-signal);
}
#hud #hud-map-frame .fc-link-icon { display: inline-flex; width: 12px; height: 12px; }
#hud #hud-map-frame .fc-link-icon svg { width: 100%; height: 100%; }

/* 上段: リアルタイム図式 + 2行要約 */
#hud #hud-map-frame .fc-diagram-box {
  display: grid; grid-template-columns: 94px minmax(0, 1fr);
  gap: var(--space-3); align-items: center;
  padding: var(--space-3);
  margin-bottom: var(--space-4);
  border-radius: var(--radius-control);
  box-shadow: inset 0 0 0 1px var(--fill-2);
  background: var(--glass-inset);
}
#hud #hud-map-frame .fc-diagram-svg { width: 94px; height: 74px; display: block; }
#hud #hud-map-frame .fc-diagram-summary { display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; }
#hud #hud-map-frame .fc-sum-row { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
#hud #hud-map-frame .fc-badge {
  flex: none; padding: 1px var(--space-2); border-radius: var(--radius-micro);
  font-size: var(--font-xxs); font-weight: 600; letter-spacing: var(--tracking-label);
}
#hud #hud-map-frame .fc-badge-cam { background: var(--color-primary-fill); color: var(--color-primary-hover); }
#hud #hud-map-frame .fc-badge-frm { background: var(--role-target-fill); color: var(--color-signal); }
#hud #hud-map-frame .fc-sum-val {
  color: var(--text); font-size: var(--font-xs); font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
#hud #hud-map-frame .fc-sum-meta {
  color: var(--text-dim); font-size: var(--font-xxs);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* セクション見出し行 */
#hud #hud-map-frame .fc-sec-head {
  display: flex; align-items: center; justify-content: space-between; gap: var(--space-2);
  margin: var(--space-3) 0 var(--space-2);
}
#hud #hud-map-frame .fc-sec-label {
  color: var(--text-dim); font-size: var(--font-xxs); letter-spacing: var(--tracking-label);
}
#hud #hud-map-frame .fc-sec-hint {
  color: var(--text-faint); font-size: var(--font-xxs);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
#hud #hud-map-frame .fc-inline-picker { margin: 0; gap: 0; }
#hud #hud-map-frame .fc-inline-picker .w-btn {
  padding: var(--space-1) var(--space-3); font-size: var(--font-xxs);
  max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* 図案タイル帯 */
#hud #hud-map-frame .fc-tile-grid {
  display: grid; gap: var(--space-1);
}
#hud #hud-map-frame .fc-center-grid {
  grid-template-columns: repeat(auto-fit, minmax(46px, 1fr));
}
#hud #hud-map-frame .fc-rot-grid {
  grid-template-columns: repeat(auto-fit, minmax(56px, 1fr));
}
#hud #hud-map-frame .fc-tile {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: var(--space-1); padding: var(--space-2) var(--space-1);
  border-radius: var(--radius-control);
  background: var(--glass-control);
  color: var(--text-dim);
  font-size: var(--font-xxs); line-height: 1.2;
  cursor: pointer; min-width: 0;
  transition: background var(--transition-fast), color var(--transition-fast), box-shadow var(--transition-fast);
}
#hud #hud-map-frame .fc-tile:hover { background: var(--glass-control-hover); color: var(--text); }
#hud #hud-map-frame .fc-tile.on {
  background: var(--color-primary-fill);
  box-shadow: inset 0 0 0 1px var(--color-primary);
  color: var(--color-primary-hover);
}
#hud #hud-map-frame .fc-signal-tiles .fc-tile.on {
  background: var(--role-target-fill);
  box-shadow: inset 0 0 0 1px var(--role-target-edge);
  color: var(--color-signal);
}
#hud #hud-map-frame .fc-tile-icon { display: inline-flex; width: 17px; height: 17px; }
#hud #hud-map-frame .fc-tile-icon svg { width: 100%; height: 100%; }
#hud #hud-map-frame .fc-tile-label {
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* L 点クイック行(1行コンパクト) */
#hud #hud-map-frame .fc-lagrange-strip {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(36px, 1fr));
  gap: var(--space-1); margin-top: var(--space-1);
}
#hud #hud-map-frame .fc-lagrange-strip .fc-tile {
  flex-direction: row; padding: var(--space-1) var(--space-2);
}

/* 軌道分離時だけ開く独立フレーム欄 */
#hud #hud-map-frame .fc-detached-box {
  margin-top: var(--space-3); padding: var(--space-3);
  border-radius: var(--radius-control);
  box-shadow: inset 0 0 0 1px var(--role-target-edge);
  background: var(--role-target-fill);
}
#hud #hud-map-frame .fc-detached-box .fc-sec-head { margin-top: 0; }
#hud #hud-map-frame .fc-detached-box .fc-sec-label { color: var(--color-signal); }
#hud #hud-map-frame .fc-detached-box .fc-rot-grid { margin-top: var(--space-2); }

/* 角度コンパス(円盤図式 + 基準面チップ) */
#hud #hud-map-frame .fc-compass-stage {
  display: grid; grid-template-columns: 108px minmax(0, 1fr);
  gap: var(--space-3); align-items: center;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-control);
  box-shadow: inset 0 0 0 1px var(--fill-2);
  background: var(--glass-inset);
}
#hud #hud-map-frame .fc-compass-dial { position: relative; width: 108px; height: 92px; }
#hud #hud-map-frame .fc-compass-svg { width: 108px; height: 92px; display: block; }
#hud #hud-map-frame .fc-compass-ring { cursor: pointer; transition: opacity var(--transition-fast); }
#hud #hud-map-frame .fc-compass-ring:hover { opacity: 1; }
#hud #hud-map-frame .fc-compass-spot {
  position: absolute; display: flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; padding: 0;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px var(--edge);
  background: var(--surface-1);
  color: var(--text-muted);
  font-size: var(--font-xxs); font-weight: 600;
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast), box-shadow var(--transition-fast);
}
#hud #hud-map-frame .fc-compass-spot:hover { background: var(--glass-control-hover); color: var(--text); }
#hud #hud-map-frame .fc-compass-spot.on {
  background: var(--color-primary-fill-strong);
  box-shadow: inset 0 0 0 1px var(--color-primary);
  color: var(--color-primary-hover);
}
#hud #hud-map-frame .fc-spot-top { top: 2px; left: 50%; transform: translateX(-50%); }
#hud #hud-map-frame .fc-spot-side { right: 0; top: 50%; transform: translateY(-46%); }

#hud #hud-map-frame .fc-plane-col { display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; }
#hud #hud-map-frame .fc-plane-chip {
  display: flex; align-items: center; gap: var(--space-2);
  width: 100%; padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-control);
  background: var(--glass-control);
  color: var(--text-dim); font-size: var(--font-xs); text-align: left;
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast), box-shadow var(--transition-fast);
}
#hud #hud-map-frame .fc-plane-chip:hover { background: var(--glass-control-hover); color: var(--text); }
#hud #hud-map-frame .fc-plane-chip.on {
  background: var(--color-primary-fill);
  box-shadow: inset 0 0 0 1px var(--color-primary);
  color: var(--color-primary-hover);
}
#hud #hud-map-frame .fc-plane-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
#hud #hud-map-frame .fc-plane-ecliptic .fc-plane-dot { background: var(--color-primary); }
#hud #hud-map-frame .fc-plane-equator .fc-plane-dot { background: var(--color-signal); }
#hud #hud-map-frame .fc-plane-moonOrbit .fc-plane-dot { background: var(--color-info); }

/* 下段光学バー + 詳細ドロワー */
#hud #hud-map-frame .fc-footer-bar {
  display: flex; align-items: center; justify-content: space-between; gap: var(--space-2);
  margin-top: var(--space-3); padding-top: var(--space-3);
  box-shadow: inset 0 1px 0 var(--fill-2);
}
#hud #hud-map-frame .fc-footer-chips { display: flex; align-items: center; gap: var(--space-1); flex-wrap: wrap; }
#hud #hud-map-frame .fc-chip {
  display: inline-flex; align-items: center; gap: var(--space-1);
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-control);
  background: var(--glass-control);
  color: var(--text-muted); font-size: var(--font-xxs); white-space: nowrap;
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast), box-shadow var(--transition-fast);
}
#hud #hud-map-frame .fc-chip:hover { background: var(--glass-control-hover); color: var(--text); }
#hud #hud-map-frame .fc-chip.on {
  background: var(--color-primary-fill);
  box-shadow: inset 0 0 0 1px var(--color-primary);
  color: var(--color-primary-hover);
}
#hud #hud-map-frame .fc-chip-mono { font-variant-numeric: tabular-nums; letter-spacing: var(--tracking-label); }
#hud #hud-map-frame .fc-chip-icon { display: inline-flex; width: 12px; height: 12px; }
#hud #hud-map-frame .fc-chip-icon svg { width: 100%; height: 100%; }

#hud #hud-map-frame .fc-detail-drawer {
  margin-top: var(--space-3); padding: var(--space-3);
  border-radius: var(--radius-control);
  box-shadow: inset 0 0 0 1px var(--fill-2);
  background: var(--glass-inset);
  display: flex; flex-direction: column; gap: var(--space-3);
}
#hud #hud-map-frame .camera-fov-control {
  display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2);
}
#hud #hud-map-frame .camera-control-label {
  flex: 0 0 100%; color: var(--text-dim); font-size: var(--font-xxs); letter-spacing: var(--tracking-label);
}
#hud #hud-map-frame .camera-fov-control .w-slider { flex: 1 1 auto; min-width: 60px; }
#hud #hud-map-frame .camera-fov-control .w-slider:disabled,
#hud #hud-map-frame .camera-fov-control .w-input:disabled { opacity: 0.4; cursor: not-allowed; }
#hud #hud-map-frame .camera-fov-control .w-input { width: 52px; }
#hud #hud-map-frame .camera-control-unit { color: var(--text-dim); font-size: var(--font-xs); }
#hud #hud-map-frame .camera-fov-note {
  flex: 0 0 100%; color: var(--text-dim); font-size: var(--font-xxs); line-height: 1.45;
}

@media ${MQ_COMPACT} {
  #hud #hud-map-frame .fc-diagram-box { grid-template-columns: 1fr; }
  #hud #hud-map-frame .fc-diagram-svg { display: none; }
  #hud #hud-map-frame .fc-compass-stage { grid-template-columns: 1fr; }
  #hud #hud-map-frame .fc-compass-dial { margin: 0 auto; }
}
@media ${MQ_COARSE} {
  #hud #hud-map-frame .fc-compass-spot {
    width: var(--hit-target-min); height: var(--hit-target-min);
  }
  #hud #hud-map-frame .fc-tile { min-height: var(--hit-target-min); }
}
`;
