// マップ右レールの路線図・軌道図・対象検索の見た目。
import { MQ_COARSE } from '../../../hud/breakpoints';

export const ORBITAL_OBJECT_PANEL_STYLE = `
#hud-orbital-objects { display: flex; flex-direction: column; gap: var(--space-3); }
#hud-orbital-objects .oo-head { display: flex; align-items: center; gap: var(--space-3); min-height: var(--row-min-h-s); }
#hud-orbital-objects .oo-head h3 { margin: 0; }
#hud-orbital-objects .oo-caution { margin-left: auto; color: var(--role-caution); font-size: var(--font-xxs); white-space: nowrap; }
#hud-orbital-objects .oo-collapse {
  background: none; border: none; color: var(--text-dim); font: inherit; cursor: pointer; pointer-events: auto;
}
#hud-orbital-objects .oo-body { display: flex; flex-direction: column; gap: var(--space-3); }
#hud-orbital-objects .oo-body.collapsed { display: none !important; }
#hud-orbital-objects .oo-chart-view.hidden { display: none !important; }

/* 路線図: 根から等間隔の駅。経路の区間だけを自分の色で太くする。 */
#hud-orbital-objects .oo-strip { position: relative; height: 56px; box-shadow: inset 0 -1px 0 var(--role-hairline); }
#hud-orbital-objects .oo-line, #hud-orbital-objects .oo-route {
  position: absolute; top: 27px; height: 1px; background: var(--fill-3); pointer-events: none;
}
#hud-orbital-objects .oo-route { top: 26px; height: 3px; border-radius: var(--radius-pill); background: var(--role-own); }
#hud-orbital-objects .oo-station {
  position: absolute; top: 2px; transform: translateX(-50%); display: flex; flex-direction: column;
  align-items: center; gap: var(--space-1); padding: 0; background: none; min-width: 30px;
}
#hud-orbital-objects .oo-station:hover { background: none; }
#hud-orbital-objects .oo-station-badge { height: 14px; font-size: var(--font-xxs); color: var(--role-label); white-space: nowrap; }
#hud-orbital-objects .oo-station-badge .oo-near { color: var(--role-caution); }
#hud-orbital-objects .oo-station-dot {
  width: 9px; height: 9px; margin-block: var(--space-2); border-radius: var(--radius-pill); background: var(--text-faint);
}
#hud-orbital-objects .oo-station.on-route .oo-station-dot { background: var(--role-own); }
#hud-orbital-objects .oo-station.is-current .oo-station-dot {
  box-shadow: 0 0 0 3px var(--surface-1), 0 0 0 4px var(--role-own);
}
#hud-orbital-objects .oo-station-name { font-size: var(--font-xxs); color: var(--text-muted); white-space: nowrap; }
#hud-orbital-objects .oo-station.is-current .oo-station-name { color: var(--role-own); }

#hud-orbital-objects .oo-kinds { display: flex; flex-wrap: wrap; gap: var(--space-2); }
#hud-orbital-objects .oo-kinds .w-btn { border-radius: var(--radius-pill); }
/* 出している種類は中立のまま、出していない種類だけを淡くする — 全部が自分の色で点くと図より目立つ。 */
#hud-orbital-objects .oo-kinds .w-btn.on { background: var(--glass-control); color: var(--text); }
#hud-orbital-objects .oo-kinds .w-btn:not(.on) { opacity: var(--toggle-off-opacity); }

/* 軌道図: 正方形の中に、中心天体と同心円。位置は一辺を 100% とした割合で置く。 */
#hud-orbital-objects .oo-diagram { position: relative; width: 100%; aspect-ratio: 1 / 1; }
#hud-orbital-objects .oo-ring {
  position: absolute; box-sizing: border-box; border-radius: var(--radius-pill);
  box-shadow: inset 0 0 0 1px var(--role-hairline); pointer-events: none;
}
#hud-orbital-objects .oo-mark, #hud-orbital-objects .oo-center {
  position: absolute; transform: translate(-50%, -50%); color: var(--text-muted);
  background: var(--glass-control); font-size: var(--font-xs);
}
#hud-orbital-objects .oo-center { width: 32px; height: 32px; flex: none; background: var(--surface-3); }
#hud-orbital-objects .oo-mark .w-btn-icon, #hud-orbital-objects .oo-center .w-btn-icon { margin-right: 0; }
#hud-orbital-objects .oo-mark.is-own { color: var(--role-own); }
#hud-orbital-objects .oo-mark.is-tgt { color: var(--role-target); box-shadow: 0 0 0 1px var(--role-target); background: var(--role-target-fill); }
#hud-orbital-objects .oo-mark.is-focus, #hud-orbital-objects .oo-center.is-focus {
  color: var(--role-own); box-shadow: 0 0 0 2px var(--role-own); background: var(--role-own-fill);
}
#hud-orbital-objects .oo-label {
  position: absolute; transform: translateY(-50%); font-size: var(--font-xxs); color: var(--role-label);
  white-space: nowrap; pointer-events: none;
}
#hud-orbital-objects .oo-label.is-own, #hud-orbital-objects .oo-label.is-focus { color: var(--role-own); }
#hud-orbital-objects .oo-label.is-tgt { color: var(--role-target); }
#hud-orbital-objects .oo-label.is-near { color: var(--role-caution); }
#hud-orbital-objects .oo-center-name {
  position: absolute; left: 50%; transform: translateX(-50%); top: calc(50% + 20px);
  font-size: var(--font-xxs); color: var(--role-data); white-space: nowrap; pointer-events: none;
}

#hud-orbital-objects .oo-search { display: flex; flex-direction: column; gap: var(--space-2); }
#hud-orbital-objects .oo-search.hidden { display: none !important; }
#hud-orbital-objects .oo-search-bar { display: flex; gap: var(--space-2); }
#hud-orbital-objects .oo-search-bar .w-input { flex: 1 1 auto; min-width: 0; }
#hud-orbital-objects .oo-search-results {
  display: flex; flex-direction: column; gap: var(--space-1);
  max-height: var(--overlay-max-h-s); overflow-y: auto; overscroll-behavior: contain;
}
#hud-orbital-objects .oo-search-row { display: flex; align-items: baseline; gap: var(--space-3); }
#hud-orbital-objects .oo-search-detail { margin-left: auto; color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#hud-orbital-objects .oo-empty { padding: var(--space-5); text-align: center; color: var(--text-dim); }
#hud-orbital-objects .oo-empty.hidden { display: none !important; }
#hud-orbital-objects .oo-help { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-5); color: var(--text-dim); font-size: var(--font-xxs); }
@media ${MQ_COARSE} {
  #hud-orbital-objects .oo-strip { height: 64px; }
  #hud-orbital-objects .oo-station { min-width: var(--hit-target-min); }
}
`;
