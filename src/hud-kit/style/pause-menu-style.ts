// 一時停止 / 設定パネル(#hud-pause-menu)の CSS。
import { MQ_COMPACT, MQ_MEDIUM_DOWN, MQ_SHORT } from '../breakpoints';

export const PAUSE_MENU_STYLE = `
/* ポーズメニュー(#hud-pause-menu)。上から ヘッダー(ロゴ・外側タブ)/状態の帯/本文 の縦積み。
   最小化トグルと閉じるボタンはパネル右上端へ浮かせる。 */
#hud-pause-menu {
  position: fixed; display: none; flex-direction: column; gap: var(--space-5);
  --pm-expanded-width: 880px;
  /* 右上端へ浮かせたボタン(20px×2+gap+右offset)のぶん、ヘッダーの右端を空ける幅。 */
  --pm-actions-reserve: 56px;
  width: min(var(--pm-expanded-width), calc(100vw - var(--space-6) - var(--space-6)));
  max-height: var(--overlay-max-h-l);
  overflow: hidden; pointer-events: auto;
}
#hud #hud-pause-menu { padding: var(--space-6); }
#hud-pause-menu.open { display: flex; }
/* 収納時はボタン行だけを残す小さな帯。中身をすべて畳み、パネルはボタンと余白の寸法へ縮む。 */
#hud-pause-menu.open.minimized {
  flex-direction: row; justify-content: flex-end;
  width: auto; min-width: 0; max-height: none;
}
#hud #hud-pause-menu.minimized { padding: var(--space-3); }
#hud-pause-menu.minimized .pm-header,
#hud-pause-menu.minimized .pm-status { display: none; }
#hud-pause-menu.minimized .pm-header-actions { position: static; }

/* ヘッダー: ロゴ | 外側タブ | (ボタンの予約) の3列。外側タブはパネルの中央に来る。 */
#hud-pause-menu .pm-header {
  display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(var(--pm-actions-reserve), 1fr);
  align-items: end; gap: var(--space-6); min-width: 0; cursor: move;
}
#hud-pause-menu .pm-brand { display: flex; align-items: flex-end; gap: var(--space-4); min-width: 0; }
#hud-pause-menu .pm-brand .title-logotype { font-size: clamp(1.3rem, 2.6vw, 1.9rem); }
#hud-pause-menu .pm-brand .title-logotype sup,
#hud-pause-menu .pm-brand .title-logotype sub {
  left: calc(100% + var(--space-2));
  font-size: clamp(0.5rem, 0.9vw, 0.65rem);
}
#hud-pause-menu .pm-brand-version {
  /* ロゴ右側の装飾記号と重ならないよう、最も長い行(Tepui)の右肩より外へ出す。 */
  margin-left: var(--space-6);
  color: var(--text-dim); font-size: var(--font-xxs); letter-spacing: var(--tracking-label);
}
#hud-pause-menu .pm-header-actions {
  position: absolute; top: var(--space-4); right: var(--space-4);
  display: flex; align-items: center; gap: var(--space-2); flex: 0 0 auto;
}
#hud-pause-menu .pm-header-actions .w-close, #hud-pause-menu .pm-minimize {
  flex: 0 0 auto; width: 20px; height: 20px; border-radius: 50%;
}
#hud-pause-menu .pm-minimize {
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0; font: inherit; font-size: var(--font-m); border: 0;
  background: var(--glass-control); color: var(--body); cursor: pointer;
}
#hud-pause-menu .pm-minimize:hover { color: var(--color-primary-hover); background: var(--glass-control-hover); }

/* 外側タブ: ヘッダー中央のセグメント。内側タブ(設定面の左の縦並び)とは形で区別する。 */
#hud-pause-menu .pm-tabs {
  display: inline-flex; gap: var(--space-1); padding: var(--space-1);
  border: 0; border-radius: var(--radius-control);
}
#hud-pause-menu .pm-tabs .w-btn {
  display: inline-flex; align-items: center; justify-content: center;
  padding: var(--space-3) var(--space-6); border: 0; border-radius: var(--radius-micro);
  font-size: var(--font-m); font-weight: 600; letter-spacing: 0.04em;
  background: transparent; color: var(--text-dim); box-shadow: none;
}
#hud-pause-menu .pm-tabs .w-btn:hover { background: var(--glass-control); color: var(--color-primary-hover); transform: none; }
#hud-pause-menu .pm-tabs .w-btn.on { background: var(--color-primary-fill); color: var(--color-primary); }

/* 状態の帯: 止まっていることの印と、止めたステージ・経過時間。 */
#hud-pause-menu .pm-status {
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-6);
  padding: var(--space-3) var(--space-5); border-radius: var(--radius-panel);
  font-size: var(--font-s); font-variant-numeric: tabular-nums;
}
#hud-pause-menu .pm-status[hidden] { display: none; }
#hud-pause-menu .pm-status-paused {
  display: inline-flex; align-items: center; gap: var(--space-3);
  color: var(--color-primary); font-size: var(--font-xxs); font-weight: 700; letter-spacing: var(--tracking-label);
}
#hud-pause-menu .pm-status-pip {
  width: var(--space-3); height: var(--space-3); border-radius: 50%;
  background: var(--color-primary); box-shadow: 0 0 0 var(--space-1) var(--color-primary-fill);
}
#hud-pause-menu .pm-status .k { margin-right: var(--space-2); color: var(--text-dim); font-size: var(--font-xs); }
#hud-pause-menu .pm-status .v { color: var(--text); }

#hud-pause-menu .pm-body.hidden { display: none; }
#hud-pause-menu .pm-body { display: flex; min-width: 0; flex-direction: column; min-height: 0; flex: 1 1 auto; }
#hud-pause-menu .pm-tab-content {
  flex: 1 1 auto; min-width: 0; min-height: 0;
  overflow-y: auto; overscroll-behavior: contain;
}
#hud-pause-menu .pm-tab-panel[hidden],
#hud-pause-menu .pm-settings-view[hidden] { display: none; }
#hud-pause-menu .pm-tab-panel { display: flex; flex-direction: column; gap: var(--space-4); }

/* 一時停止の操作タイル: 名前・キーキャップ・何が起きるかの1行。主操作だけが自分の色を持つ。
   span. まで指定して .w-btn 側の display/padding/font-size より確実に勝たせる。 */
#hud-pause-menu .pm-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); }
#hud-pause-menu span.pm-tile {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--space-1) var(--space-4);
  min-width: 0; min-height: calc(var(--hit-target-min) + var(--space-5));
  padding: var(--space-5); border-radius: var(--radius-panel); text-align: left;
  background: var(--glass-control); color: var(--text); box-shadow: none;
  font-size: var(--font-m); font-weight: 600; letter-spacing: 0.02em;
}
#hud-pause-menu span.pm-tile:hover { background: var(--glass-control-hover); color: var(--color-primary-hover); }
#hud-pause-menu span.pm-tile.w-btn--primary { background: var(--color-primary-fill); color: var(--color-primary); }
#hud-pause-menu span.pm-tile.w-btn--primary:hover { color: var(--color-primary-hover); }
#hud-pause-menu span.pm-tile > .ui-key { grid-column: 2; grid-row: 1 / span 2; }
#hud-pause-menu span.pm-tile > .pm-tile-note {
  grid-column: 1; grid-row: 2;
  color: var(--text-dim); font-size: var(--font-xs); font-weight: 400; letter-spacing: 0;
}

/* 下段: BGM 音量の行と、主操作から最も遠い右端の「タイトル画面に戻る」。 */
#hud-pause-menu .pm-footer { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-3); }
#hud-pause-menu .pm-volume {
  display: flex; align-items: center; gap: var(--space-5); min-width: 0;
  padding: var(--space-3) var(--space-5); border-radius: var(--radius-panel);
}
#hud-pause-menu .pm-volume .k { flex: 0 0 auto; color: var(--text-dim); font-size: var(--font-s); }
#hud-pause-menu .pm-volume .w-slider { flex: 1 1 auto; min-width: 0; }
#hud-pause-menu span.pm-quit {
  display: inline-flex; align-items: center; justify-content: center;
  padding: var(--space-3) var(--space-5); border-radius: var(--radius-panel);
  background: var(--fill-1); color: var(--text-muted); box-shadow: none; font-size: var(--font-s);
}
#hud-pause-menu span.pm-quit:hover { background: var(--fill-2); color: var(--text); }

@media ${MQ_MEDIUM_DOWN} {
  #hud-pause-menu { min-width: 0; width: calc(100vw - var(--space-6) - var(--space-6)); }
}
@media ${MQ_COMPACT} {
  #hud-pause-menu { gap: var(--space-4); }
  #hud #hud-pause-menu { padding: var(--space-4); }
  /* ロゴの行と外側タブの行に分ける。ロゴの行の右端はボタンのぶん空ける。 */
  #hud-pause-menu .pm-header { grid-template-columns: minmax(0, 1fr); gap: var(--space-4); }
  #hud-pause-menu .pm-brand { padding-right: var(--pm-actions-reserve); }
  #hud-pause-menu .pm-tabs { display: flex; }
  #hud-pause-menu .pm-tabs .w-btn { flex: 1 1 0; min-width: 0; }
  #hud-pause-menu .pm-actions,
  #hud-pause-menu .pm-footer { grid-template-columns: minmax(0, 1fr); }
}
@media ${MQ_SHORT} {
  #hud-pause-menu { gap: var(--space-3); }
  #hud-pause-menu span.pm-tile { min-height: var(--hit-target-min); padding: var(--space-3) var(--space-5); }
}`;
