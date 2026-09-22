// セーブブラウザ右ペイン(手動セーブの一覧)の DOM 構築。ステージ切替タブと、手動セーブ1件ごとの
// カードを組む。操作はコールバックで呼び出し側へ返す。
import { MANUAL_SAVE_LIMIT } from '../save/save-slots';
import type { SaveSlotMeta, SnapshotMeta } from '../save/slot-data';
import { fmtDist, fmtSpeed, fmtTime, fmtDateTime } from '../../hud/utils';
import { Button, Meter, TabBar } from '../../hud/widgets';
import { injectOnce } from '../../hud/inject-style';
import { smallBtn, stageLabel } from './shared';

const STYLE = `
#save-browser .sb-stage-tabs { display: flex; gap: var(--space-2); }
#save-browser .sb-snapshot-list { display: flex; flex-direction: column; gap: var(--space-2); }
#save-browser .sb-snap-card {
  display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3) var(--space-4);
  border: 0; border-radius: var(--radius-m);
}
#save-browser .sb-snap-loadable { cursor: pointer; }
#save-browser .sb-snap-loadable:hover { background: var(--fill-1); }
#save-browser .sb-snap-name { font-size: var(--font-s); }
#save-browser .sb-snap-row { font-size: var(--font-xs); color: var(--text-dim); }
/* HP バーは細いモノトーン — このパネルの主役はセーブ操作なので、HP 表示を他の注目要素と競合させない。 */
#save-browser .sb-snap-hp-meter .w-meter-track { height: 3px; border-radius: var(--radius-s); }
#save-browser .sb-snap-hp-meter .w-meter-fill { background: var(--text-dim); }
#save-browser .sb-snap-actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
`;

// 形式の版が合わず、読み込めない手動セーブに添える文面。
const UNREADABLE_SNAPSHOT = '形式の版が違うため、この手動セーブは読み込めません。';

// 数値であるはずのメタ項目 v を、有限でなければ 0 に均す。取り込んだファイルでは欠けていることが
// あり、そのまま書式化すると一覧の組み立てごと落ちる。
function num(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

interface SnapshotPaneCallbacks {
  readonly onSaveNow: () => void;
  readonly onSelectStage: (stageId: string) => void;
  // refusal は読み込めない理由の文面で、読み込めるなら null。
  readonly onLoadSnapshot: (snapshotId: string, refusal: string | null) => void;
  readonly onTogglePin: (snapshotId: string, currentlyPinned: boolean) => void;
  readonly onRenameSnapshot: (snapshotId: string) => void;
  readonly onDeleteSnapshot: (snapshotId: string) => void;
  readonly onBranch: (slotId: string, snapshotId: string) => void;
  // 天体 id → 表示名。
  readonly nameOf: (id: string) => string;
  // 手動セーブの本体が、いまの形式の版で読めるか。
  readonly isReadable: (snapshotId: string) => boolean;
}

// 右ペイン(手動セーブの一覧)を組み立てる。slot が null なら選択待ちの案内を返す。viewedStageId が
// null なら slot の先頭のステージを出す。activeSlotId/activePlayingStageId は、いま実際にプレイして
// いるセーブデータ・ステージ(プレイ中の周回が無ければ activePlayingStageId は null)。
export function buildSnapshotPane(
  slot: SaveSlotMeta | null, viewedStageId: string | null, activeSlotId: string | null,
  activePlayingStageId: string | null, canSaveNow: boolean, callbacks: SnapshotPaneCallbacks,
): HTMLElement {
  injectOnce('save-browser-snapshot-pane', STYLE);
  const wrap = document.createElement('div');
  if (!slot) {
    const empty = document.createElement('div');
    empty.className = 'sb-empty';
    empty.textContent = '左の一覧からセーブデータを選んでください。';
    wrap.appendChild(empty);
    return wrap;
  }
  const stageId = viewedStageId ?? slot.stages[0]?.stageId ?? null;
  const history = stageId ? slot.stages.find((h) => h.stageId === stageId) ?? null : null;
  const manualSaves = history?.snapshots ?? [];

  const title = document.createElement('div');
  title.className = 'sb-pane-title';
  title.textContent = `手動セーブ (${manualSaves.length}/${MANUAL_SAVE_LIMIT})`;
  wrap.appendChild(title);

  const saveBtn = new Button('今の状態をセーブする', callbacks.onSaveNow, undefined, 'primary');
  saveBtn.element.id = 'sb-save-now';
  saveBtn.element.classList.add('sb-btn');
  saveBtn.setEnabled(canSaveNow);
  saveBtn.element.title = canSaveNow ? '' : '決着後の状態は復元できないため残せません';
  wrap.appendChild(saveBtn.element);

  if (slot.stages.length > 1) {
    const tabsWrap = document.createElement('div');
    tabsWrap.className = 'sb-stage-tabs';
    const tabBar = new TabBar<string>(
      slot.stages.map((h) => [h.stageId, stageLabel(h.stageId)] as const),
      (id) => callbacks.onSelectStage(id),
    );
    tabBar.setSelected(stageId ?? '');
    tabsWrap.appendChild(tabBar.element);
    wrap.appendChild(tabsWrap);
  }

  // 復元できるのは、いま遊んでいるスロットの、いま遊んでいるステージのものだけ。
  const loadable = slot.id === activeSlotId && activePlayingStageId !== null && stageId === activePlayingStageId;
  wrap.appendChild(buildSnapshotList(manualSaves, slot, loadable, callbacks));
  return wrap;
}

// 手動セーブのカード列を組み立てる。
function buildSnapshotList(
  list: readonly SnapshotMeta[], slot: SaveSlotMeta, loadable: boolean, callbacks: SnapshotPaneCallbacks,
): HTMLElement {
  const el = document.createElement('div');
  el.className = 'sb-snapshot-list';
  // 0件なら、一覧の代わりに「なし」を出す。
  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'sb-empty';
    empty.textContent = 'なし';
    el.appendChild(empty);
    return el;
  }
  for (const s of list) el.appendChild(buildSnapshotCard(s, slot, loadable, callbacks));
  return el;
}

// 1件の手動セーブのカードを組み立てる。ダブルクリックでロードを、右側のボタンで
// クリップ切替・改名・削除・分岐を、それぞれコールバックへ委ねる。loadable は、いま遊んでいる
// セーブデータ・ステージの手動セーブか。
function buildSnapshotCard(
  s: SnapshotMeta, slot: SaveSlotMeta, loadable: boolean, callbacks: SnapshotPaneCallbacks,
): HTMLElement {
  // 取り込んだファイル由来のメタは欠けていたり別物だったりし得るので、表示前に必ず均す。
  const hpPct = Math.max(0, Math.min(100, num(s.hpRatio) * 100));
  const readable = callbacks.isReadable(s.id);
  const refusal = !readable ? UNREADABLE_SNAPSHOT
    : !loadable ? 'いま遊んでいるセーブデータ・ステージの手動セーブだけを復元できます。'
      : null;

  const card = document.createElement('div');
  card.className = 'sb-snap-card';
  card.classList.toggle('ui-selectable', refusal === null);
  card.classList.toggle('sb-snap-loadable', refusal === null);
  card.title = refusal ?? 'ダブルクリックでロード';
  // ボタンの click は自身で止まるが dblclick は通過するため、カード自身の判定で除外する。
  card.addEventListener('dblclick', (e) => {
    if ((e.target as HTMLElement).closest('.w-btn')) return;
    callbacks.onLoadSnapshot(s.id, refusal);
  });

  const name = document.createElement('div');
  name.className = 'sb-snap-name';
  name.textContent = String(s.name ?? '');
  card.appendChild(name);

  const row1 = document.createElement('div');
  row1.className = 'sb-snap-row';
  row1.textContent = `MET ${fmtTime(num(s.simTime))} / ${fmtDateTime(num(s.createdAtReal) / 1000)}`;
  card.appendChild(row1);

  const row2 = document.createElement('div');
  row2.className = 'sb-snap-row';
  row2.textContent = `${callbacks.nameOf(s.centerBodyId)} 高度 ${fmtDist(num(s.altitude))} / 速度 ${fmtSpeed(num(s.speed))}`;
  card.appendChild(row2);

  // HP の残りを細いメーターで示す。
  const hpMeter = new Meter();
  hpMeter.element.classList.add('sb-snap-hp-meter');
  hpMeter.setRatio(hpPct / 100);
  card.appendChild(hpMeter.element);

  const row3 = document.createElement('div');
  row3.className = 'sb-snap-row';
  row3.textContent = `艦 ${num(s.playerCount)} / 敵残 ${num(s.enemyAliveCount)}`;
  card.appendChild(row3);

  // 読めない版の記録は、ホバーの出ないタッチでも分かるようカードの上に理由を書く。
  if (!readable) {
    const unreadable = document.createElement('div');
    unreadable.className = 'sb-snap-row';
    unreadable.textContent = UNREADABLE_SNAPSHOT;
    card.appendChild(unreadable);
  }

  const actions = document.createElement('div');
  actions.className = 'sb-snap-actions';
  const pinBtn = new Button(
    s.pinned ? '📌 解除' : '📌 クリップ', () => callbacks.onTogglePin(s.id, s.pinned), undefined,
    ['secondary', 'dense'],
  );
  pinBtn.element.classList.add('sb-btn');
  pinBtn.setOn(s.pinned);
  actions.appendChild(pinBtn.element);
  actions.appendChild(smallBtn('✎', '名前変更', () => callbacks.onRenameSnapshot(s.id)));
  actions.appendChild(smallBtn('🗑', '削除', () => callbacks.onDeleteSnapshot(s.id)));
  actions.appendChild(smallBtn('⑂', 'ここから分岐', () => callbacks.onBranch(slot.id, s.id)));
  card.appendChild(actions);

  return card;
}
