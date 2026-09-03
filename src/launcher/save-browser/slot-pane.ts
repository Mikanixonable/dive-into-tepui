// セーブブラウザ左ペイン(セーブデータ一覧)の DOM 構築。
// 一覧行と行ごとの操作ボタン、新規作成/取り込みの導線を組み立てる。
// 表示対象の選択・実際の改名/複製/削除などの実処理は、コールバックを通じて呼び出し側へ委ねる。
import type { SaveSlotMeta } from '../../game/save/save-data';
import { fmtDateTime } from '../../game/hud/utils';
import { Button } from '../../game/hud/widgets';
import { injectOnce } from '../../game/hud/widgets/inject-style';
import { MQ_COMPACT } from '../../game/hud/breakpoints';
import { mainBtn, smallBtn, stageLabel } from './shared';

const STYLE = `
#save-browser .sb-pane-slots { flex: 0 0 34%; }
#save-browser .sb-slot-list { display: flex; flex-direction: column; gap: var(--space-2); }
/* アクティブ行の識別は色数を増やさず、左端 2px のオレンジ帯のみで示す。
   「見ている」行は背景をわずかに明るくするだけで区別する。 */
#save-browser .sb-slot-row {
  display: flex; align-items: center; gap: var(--space-4); padding: var(--space-3) var(--space-4) var(--space-3) var(--space-3);
  border: 1px solid var(--edge); border-left: 2px solid transparent; border-radius: var(--radius-m); cursor: pointer;
}
#save-browser .sb-slot-row.viewed { background: var(--fill-1); }
#save-browser .sb-slot-row.on { border-left-color: var(--color-primary); }
#save-browser .sb-slot-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
#save-browser .sb-slot-name { font-size: var(--font-s); }
#save-browser .sb-slot-meta { font-size: var(--font-xxs); color: var(--text-dim); }
#save-browser .sb-slot-actions { display: flex; gap: var(--space-2); flex-wrap: wrap; justify-content: flex-end; }
/* 左ペインは幅が狭いので、フッターのボタンは横並びにせず縦積みにして折り返しを防ぐ。 */
#save-browser .sb-slot-footer { display: flex; flex-direction: column; gap: var(--space-3); margin-top: auto; padding-top: var(--space-3); }
#save-browser span.sb-btn.sb-btn-play { color: var(--text); border-color: var(--text-dim); }
@media ${MQ_COMPACT} {
  #save-browser .sb-pane-slots { flex: 1 1 0; }
}
`;

interface SlotsPaneCallbacks {
  readonly onSelectSlot: (id: string) => void;
  readonly onPlaySlot: (id: string) => void;
  readonly onRenameSlot: (id: string) => void;
  readonly onDuplicateSlot: (id: string) => void;
  readonly onExportSlot: (id: string) => void;
  readonly onDeleteSlot: (id: string) => void;
  readonly onNewSlot: () => void;
  readonly onImportSlot: () => void;
}

// 左ペイン(セーブデータ一覧)を組み立てる。activeSlotId は実際に遊んでいるスロット、
// viewedSlotId は一覧で選んで見ているスロットで、両者は独立に渡す。
export function buildSlotsPane(
  slots: readonly SaveSlotMeta[], activeSlotId: string | null, viewedSlotId: string | null,
  callbacks: SlotsPaneCallbacks,
): HTMLElement {
  injectOnce('save-browser-slot-pane', STYLE);
  const pane = document.createElement('div');
  pane.className = 'sb-pane sb-pane-slots';
  const title = document.createElement('div');
  title.className = 'sb-pane-title';
  title.textContent = 'セーブデータ';
  pane.appendChild(title);

  // 1件も無ければ一覧の代わりに案内文を出す。
  const list = document.createElement('div');
  list.className = 'sb-slot-list';
  if (slots.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'sb-empty';
    empty.textContent = 'セーブデータがありません。';
    list.appendChild(empty);
  } else {
    for (const s of slots) list.appendChild(buildSlotRow(s, activeSlotId, viewedSlotId, callbacks));
  }
  pane.appendChild(list);

  // 新規作成・取り込みの導線は一覧の下の常設フッターに置く。
  const footer = document.createElement('div');
  footer.className = 'sb-slot-footer';
  footer.appendChild(mainBtn('新しいセーブデータ', callbacks.onNewSlot));
  footer.appendChild(mainBtn('ファイルから取り込む', callbacks.onImportSlot));
  pane.appendChild(footer);
  return pane;
}

// 1件のセーブデータ行を組み立てる。行のクリックで表示対象の切り替えを、右側のボタンで
// 改名・複製・書き出し・削除・このデータで遊ぶ切り替えを、それぞれコールバックへ委ねる。
function buildSlotRow(
  s: SaveSlotMeta, activeSlotId: string | null, viewedSlotId: string | null, callbacks: SlotsPaneCallbacks,
): HTMLElement {
  const totalSnapshots = s.stages.reduce((sum, h) => sum + h.snapshots.length, 0);
  const active = s.id === activeSlotId;
  const viewed = s.id === viewedSlotId;

  const row = document.createElement('div');
  row.className = 'sb-slot-row';
  row.classList.toggle('viewed', viewed);
  row.classList.toggle('on', active);
  row.addEventListener('click', () => callbacks.onSelectSlot(s.id));

  // 名前と、最後に遊んだステージ・日時・保有件数の要約を1行で並べる。
  const info = document.createElement('div');
  info.className = 'sb-slot-info';
  const name = document.createElement('span');
  name.className = 'sb-slot-name';
  name.textContent = s.name + (active ? ' ▶' : '');
  const meta = document.createElement('span');
  meta.className = 'sb-slot-meta';
  meta.textContent = `${s.lastStageId === '' ? '未プレイ' : stageLabel(s.lastStageId)} / ${fmtDateTime(s.lastPlayedAtReal / 1000)} / ${totalSnapshots}件`;
  info.append(name, meta);
  row.appendChild(info);

  // 改名・複製・書き出し・削除は常設、「このデータで遊ぶ」はアクティブでないときだけ出す。
  const actions = document.createElement('div');
  actions.className = 'sb-slot-actions';
  actions.appendChild(smallBtn('✎', '名前変更', () => callbacks.onRenameSlot(s.id)));
  actions.appendChild(smallBtn('⎘', '複製', () => callbacks.onDuplicateSlot(s.id)));
  actions.appendChild(smallBtn('⇩', '書き出し', () => callbacks.onExportSlot(s.id)));
  actions.appendChild(smallBtn('🗑', '削除', () => callbacks.onDeleteSlot(s.id)));
  if (!active) {
    const playBtn = new Button('このデータで遊ぶ', () => callbacks.onPlaySlot(s.id));
    playBtn.element.classList.add('sb-btn', 'sb-btn-sm', 'sb-btn-play');
    actions.appendChild(playBtn.element);
  }
  row.appendChild(actions);
  return row;
}
