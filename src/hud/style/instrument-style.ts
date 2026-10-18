// 計器の表示部品の共通スタイル: 1行の文法(ラベル・メーター・値 単位・キー)、小見出し、状態ピップ、
// キーキャップ、主読み値、識別行、一覧の行。色は意味(--role-*)でだけ引く。
// 画面固有の CSS は置き場と並びだけを持ち、これらの見た目はここへ集約する。

// 行の内側がこの幅(px)を下回ると、値より先にキーの列を畳む。
const ROW_KEY_HIDE_BELOW_PX = 180;
// パネルの内側がこの幅(px)を下回ると、主読み値の左右ペアを縦に積む。
const READOUT_PAIR_STACK_BELOW_PX = 260;

export const INSTRUMENT_STYLE = `
:root {
  /* 行の中のメーターの最大幅。メーターは値より先に縮む。 */
  --gauge-max-w: 64px;
  --instrument-label-min: 2.5em;
  --instrument-key-col: 2.6em;
  --key-cap-min: 1.7em;
  --pip-dot: var(--space-3);
  --pip-ring: calc(var(--space-1) / 2);
  --pip-glow-radius: var(--space-3);
}

/* --- 行の文法: [ラベル] [メーター] [値 単位] [キー] ----------------------------------------
   値は切らず折り返さない。幅が足りなければ メーター → キー → ラベル(省略記号)の順に譲る。 */
.ui-rows { display: grid; font-size: var(--font-xs); line-height: 1.35; }
.ui-row {
  display: grid;
  grid-template-columns: minmax(var(--instrument-label-min), max-content) minmax(0, 1fr) auto;
  align-items: center; column-gap: var(--space-4);
  min-height: var(--row-min-h-s);
}
.ui-row > .ui-k { grid-column: 1; }
.ui-row > .ui-gauge { grid-column: 2; }
.ui-row > .ui-v { grid-column: 3; }
.ui-row:not(:has(> .ui-gauge)) {
  grid-template-columns: minmax(var(--instrument-label-min), max-content) minmax(max-content, 1fr);
}
.ui-row:not(:has(> .ui-gauge)) > .ui-v { grid-column: 2; }
.ui-k {
  display: flex; align-items: center; gap: var(--space-3); min-width: 0;
  color: var(--role-label); white-space: nowrap;
}
.ui-k-text { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.ui-v {
  justify-self: end; white-space: nowrap; color: var(--role-data);
  font-variant-numeric: tabular-nums; text-align: right;
}
/* 単位は値より一段小さく淡い。 */
.ui-u { margin-left: var(--space-1); font-size: var(--font-xxs); color: var(--role-label); }
.ui-gauge { min-width: 0; width: 100%; max-width: var(--gauge-max-w); justify-self: end; }
/* 警告の行は面を敷く。面は行の左右へ少し張り出す。 */
.ui-row.ui-warning-fill {
  margin-inline: calc(-1 * var(--space-3)); padding-inline: var(--space-3); border-radius: var(--radius-micro);
}

/* キー列つきの束: キーは束で共有する右端の列に揃え、キーを持たない行があっても値の列は揃う。 */
.ui-rows.has-keys { container-type: inline-size; }
.ui-rows.has-keys > .ui-row {
  grid-template-columns: minmax(var(--instrument-label-min), max-content) minmax(0, 1fr) auto var(--instrument-key-col);
}
.ui-rows.has-keys > .ui-row:not(:has(> .ui-gauge)) {
  grid-template-columns: minmax(var(--instrument-label-min), max-content) minmax(max-content, 1fr) var(--instrument-key-col);
}
.ui-rows.has-keys > .ui-row > .ui-key { grid-column: -2 / -1; justify-self: end; }
@container (width < ${ROW_KEY_HIDE_BELOW_PX}px) {
  .ui-rows.has-keys > .ui-row {
    grid-template-columns: minmax(var(--instrument-label-min), max-content) minmax(0, 1fr) auto;
  }
  .ui-rows.has-keys > .ui-row:not(:has(> .ui-gauge)) {
    grid-template-columns: minmax(var(--instrument-label-min), max-content) minmax(max-content, 1fr);
  }
  .ui-rows.has-keys > .ui-row > .ui-key { display: none; }
}

/* 区切りは線ではなく余白と小見出しで示す。 */
.ui-sub {
  margin: var(--space-4) 0 var(--space-1); font-size: var(--font-xxs); letter-spacing: var(--tracking-label);
  color: var(--role-meta);
}

/* --- 状態ピップ: 押せない行の ON/OFF を、点と語で示す。点灯は塗り、消灯は輪。 -------------- */
.ui-pip {
  display: inline-flex; align-items: center; gap: var(--space-3);
  font-size: var(--font-xxs); letter-spacing: var(--tracking-label); color: var(--role-meta);
}
.ui-pip::before {
  content: ''; width: var(--pip-dot); height: var(--pip-dot); border-radius: 50%;
  box-shadow: inset 0 0 0 var(--pip-ring) var(--role-meta);
}
.ui-pip.on { color: var(--role-data); }
.ui-pip.on::before { background: var(--role-data); box-shadow: none; }
/* 自分が掛けているモードだけが自分の色を帯びる。 */
.ui-pip.on.is-own { color: var(--role-own); }
.ui-pip.on.is-own::before {
  background: var(--role-own);
  box-shadow: 0 0 var(--pip-glow-radius) color-mix(in srgb, var(--role-own) var(--glow-weak), transparent);
}

/* --- キーキャップ: ショートカットの表記はこれ1種 ---------------------------------------------- */
.ui-key {
  display: inline-grid; place-items: center; min-width: var(--key-cap-min);
  height: var(--key-cap-min); padding: 0 var(--space-2);
  font: inherit; font-size: var(--font-xxs); line-height: 1; color: var(--text-muted);
  background: var(--fill-2); border-radius: calc(var(--radius-micro) / 2);
  box-shadow: inset 0 -1px 0 var(--fill-3);
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.w-btn .ui-key { margin-left: var(--space-3); }
.w-btn.on .ui-key { background: var(--role-own-fill); color: var(--role-own); }

/* --- 主読み値: パネルの答えそのもの。強弱は 主読み値 > 準主読み値 > 行 の3段 ---------------------- */
.ui-readout { display: grid; gap: 0; }
.ui-readout-value {
  font-size: var(--font-3xl); line-height: 1.05; letter-spacing: var(--tracking-title);
  font-variant-numeric: tabular-nums; color: var(--role-data); white-space: nowrap;
}
.ui-readout-value .ui-u { font-size: var(--font-l); letter-spacing: 0; }
.ui-readout-cap { font-size: var(--font-xxs); letter-spacing: var(--tracking-label); color: var(--role-label); }
.ui-readout.is-m .ui-readout-value { font-size: var(--font-2xl); }
.ui-readout.is-s .ui-readout-value { font-size: var(--font-xl); }
.ui-readout.is-tgt .ui-readout-value { color: var(--role-target); }
/* 注意・警告の段は、値を色で、記号(△ ▲)を補足の側で示す — 大きな値に記号を足すと幅が増えて隣へ寄る。 */
#hud .ui-readout-value.ui-caution::before, #hud .ui-readout-value.ui-warning::before { content: none; }
.ui-readout-value.ui-caution + .ui-readout-cap, .ui-readout-value.ui-warning + .ui-readout-cap {
  color: var(--role-caution);
}
.ui-readout-value.ui-warning + .ui-readout-cap { color: var(--role-warning); }
.ui-readout-value.ui-caution + .ui-readout-cap::before, .ui-readout-value.ui-warning + .ui-readout-cap::before {
  margin-right: var(--space-2);
}
.ui-readout-value.ui-caution + .ui-readout-cap::before { content: '△'; }
.ui-readout-value.ui-warning + .ui-readout-cap::before { content: '▲'; }
.ui-pair {
  display: grid; grid-template-columns: minmax(max-content, 1fr) minmax(0, 1fr);
  column-gap: var(--space-5); row-gap: var(--space-3); align-items: end;
}
@container (width < ${READOUT_PAIR_STACK_BELOW_PX}px) {
  .ui-pair { grid-template-columns: minmax(0, 1fr); }
}

/* --- 識別行: 対象の名前。持ち主の色(自分・ターゲット)は面と名前だけが帯びる。 -------------------- */
.ui-ident {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; column-gap: var(--space-4);
  padding: var(--space-3) var(--space-4); border-radius: var(--radius-control); background: var(--glass-inset);
}
.ui-ident-glyph { color: var(--role-label); font-size: var(--font-l); }
.ui-ident-name {
  font-size: var(--font-l); color: var(--role-data); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ui-ident-role { font-size: var(--font-xxs); letter-spacing: var(--tracking-label); color: var(--role-label); }
.ui-ident.is-tgt { background: var(--role-target-fill); }
.ui-ident.is-tgt .ui-ident-glyph, .ui-ident.is-tgt .ui-ident-name { color: var(--role-target); }
.ui-ident.is-own .ui-ident-glyph, .ui-ident.is-own .ui-ident-name { color: var(--role-own); }

/* --- 一覧の行: [グリフ] [名前] [値] [状態語]。ホバー・選択は .ui-selectable の語彙に載せる ------- */
.ui-list {
  display: grid; gap: var(--space-1); margin: 0; padding: 0; list-style: none;
  font-size: var(--font-xs); line-height: 1.35;
}
.ui-item {
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; column-gap: var(--space-4);
  min-height: var(--row-min-h-s); padding-inline: var(--space-3); margin-inline: calc(-1 * var(--space-3));
  border-radius: var(--radius-micro); color: var(--text-muted);
}
.ui-item-glyph { color: var(--role-meta); font-size: var(--font-xs); width: 1.2em; text-align: center; }
.ui-item-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ui-item-v { font-variant-numeric: tabular-nums; color: var(--text); white-space: nowrap; }
.ui-item-tag {
  font-size: var(--font-xxs); letter-spacing: var(--tracking-label); color: var(--role-label);
  min-width: 2.5em; text-align: right; white-space: nowrap;
}
.ui-item.is-tgt { background: var(--role-target-fill); color: var(--role-target); }
.ui-item.is-tgt .ui-item-glyph, .ui-item.is-tgt .ui-item-v, .ui-item.is-tgt .ui-item-tag { color: var(--role-target); }
.ui-item.is-near .ui-item-tag { color: var(--role-caution); }
/* 自分の選択は自分の色の面。自機の行は記号だけが自分の色。 */
.ui-item.is-focus { background: var(--role-own-fill); color: var(--role-own); }
.ui-item.is-focus .ui-item-glyph, .ui-item.is-focus .ui-item-tag { color: var(--role-own); }
.ui-item.is-own { color: var(--text); }
.ui-item.is-own .ui-item-glyph { color: var(--role-own); }
.ui-item .ui-u { margin-left: var(--space-2); }
`;
