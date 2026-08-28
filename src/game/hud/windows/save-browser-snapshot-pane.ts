// セーブブラウザ右ペイン(スナップショット一覧)の DOM 構築。
// クリップ済み/自動の区画分け、ステージ切替タブ、カード1件ごとの表示と操作ボタンを組み立てる。
// 表示対象の状態やクリップ・改名・削除・分岐などの実処理は、コールバックを通じて呼び出し側へ委ねる。
import { AUTO_SNAPSHOT_LIMIT, PINNED_SNAPSHOT_LIMIT } from '../../save/save-slots';
import type { SaveSlotMeta, SnapshotMeta } from '../../save/save-data';
import { fmtDist, fmtSpeed, fmtTime, fmtDateTime } from '../utils';
import { celestialBodyName } from '../frame/frame-labels';
import { Button, Meter, TabBar } from '../widgets';
import { injectOnce } from '../widgets/inject-style';
import { smallBtn, stageLabel } from './save-browser-shared';

const STYLE = `
/* このパネルで唯一の「押すと今の状態が増える」操作 — 注目させるためオレンジを残す。 */
#save-browser span#sb-capture-now {
  background: var(--color-primary-fill-weak); color: var(--color-primary); border-color: var(--color-primary-edge);
}
#save-browser span#sb-capture-now:hover { background: var(--color-primary-fill); }
#save-browser .sb-stage-tabs { display: flex; gap: var(--space-2); }
#save-browser .sb-snapshot-groups { display: flex; flex-direction: column; gap: var(--space-2); }
#save-browser .sb-snapshot-group-title { font-size: var(--font-xs); color: var(--text-dim); margin-top: var(--space-2); }
#save-browser .sb-snapshot-list { display: flex; flex-direction: column; gap: var(--space-2); }
#save-browser .sb-snap-card {
  display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3) var(--space-4);
  border: 1px solid var(--edge); border-radius: var(--radius-m);
}
#save-browser .sb-snap-loadable { cursor: pointer; }
#save-browser .sb-snap-loadable:hover { border-color: var(--text-dim); background: var(--fill-1); }
#save-browser .sb-snap-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); }
#save-browser .sb-snap-name { font-size: var(--font-s); }
#save-browser .sb-snap-badge {
  font-size: var(--font-xxs); letter-spacing: .5px; padding: 1px var(--space-3); border-radius: var(--radius-l);
  border: 1px solid var(--edge); color: var(--text-dim);
}
#save-browser .sb-snap-badge-checkpoint { color: var(--text); border-color: var(--text-dim); }
#save-browser .sb-snap-row { font-size: var(--font-xs); color: var(--text-dim); }
/* HP バーは細く、満タンでもオレンジで塗らない — このパネルの主役はセーブ操作であって
   HP 表示ではないため、他の注目要素と競合しないモノトーンに留める(danger 色も使わない)。 */
#save-browser .sb-snap-hp-meter .w-meter-track { height: 3px; border-radius: var(--radius-s); }
#save-browser .sb-snap-hp-meter .w-meter-fill { background: var(--text-dim); }
#save-browser .sb-snap-actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
/* クリップ済み(pin)状態だけは注目対象として残す — この行の意味は「消えずに残る」なので. */
#save-browser span.sb-btn-pin.on {
  background: var(--color-primary-fill-weak); color: var(--color-primary); border-color: var(--color-primary-edge);
}
`;

// 数値であるはずのメタ項目。取り込んだファイルでは欠けていることがあり、そのまま
// 書式化関数へ渡すと一覧の組み立てごと落ちてイベント配線まで届かなくなる。
function num(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

const SNAPSHOT_KIND_LABEL: Record<SnapshotMeta['kind'], string> = {
  auto: '自動', manual: '手動', checkpoint: '決着',
};

export interface SnapshotPaneCallbacks {
  readonly onCaptureNow: () => void;
  readonly onSelectStage: (stageId: string) => void;
  readonly onLoadSnapshot: (snapshotId: string, loadable: boolean) => void;
  readonly onTogglePin: (snapshotId: string, currentlyPinned: boolean) => void;
  readonly onRenameSnapshot: (snapshotId: string) => void;
  readonly onDeleteSnapshot: (snapshotId: string) => void;
  readonly onBranch: (slotId: string, snapshotId: string) => void;
}

// 右ペイン(スナップショット一覧)を組み立てる。slot が null なら選択待ちの案内だけを返す。
// activeSlotId/activePlayingStageId は、いま実際にプレイしているセーブデータ・ステージ
// (プレイ中の Game が無ければ activePlayingStageId は null)。
export function buildSnapshotPane(
  slot: SaveSlotMeta | null, viewedStageId: string | null, activeSlotId: string | null,
  activePlayingStageId: string | null, canCaptureNow: boolean, callbacks: SnapshotPaneCallbacks,
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

  const title = document.createElement('div');
  title.className = 'sb-pane-title';
  title.textContent = 'スナップショット';
  wrap.appendChild(title);

  const captureBtn = new Button('今の状態をクリップして残す', callbacks.onCaptureNow);
  captureBtn.element.id = 'sb-capture-now';
  captureBtn.element.classList.add('sb-btn');
  captureBtn.setEnabled(canCaptureNow);
  captureBtn.element.title = canCaptureNow ? '' : '決着後の状態は復元できないため残せません';
  wrap.appendChild(captureBtn.element);

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

  const pinned = history ? history.snapshots.filter((s) => s.pinned) : [];
  const auto = history ? history.snapshots.filter((s) => !s.pinned) : [];
  // 復元できるのは、いま遊んでいるスロットの、いま遊んでいるステージのものだけ。
  const loadable = slot.id === activeSlotId && activePlayingStageId !== null && stageId === activePlayingStageId;

  const groups = document.createElement('div');
  groups.className = 'sb-snapshot-groups';
  const pinnedTitle = document.createElement('div');
  pinnedTitle.className = 'sb-snapshot-group-title';
  pinnedTitle.textContent = `クリップ済み (${pinned.length}/${PINNED_SNAPSHOT_LIMIT})`;
  groups.appendChild(pinnedTitle);
  groups.appendChild(buildSnapshotList(pinned, slot, loadable, callbacks));
  const autoTitle = document.createElement('div');
  autoTitle.className = 'sb-snapshot-group-title';
  autoTitle.textContent = `自動 (${auto.length}/${AUTO_SNAPSHOT_LIMIT}・古い順に消えます)`;
  groups.appendChild(autoTitle);
  groups.appendChild(buildSnapshotList(auto, slot, loadable, callbacks));
  wrap.appendChild(groups);
  return wrap;
}

// 1区画分(クリップ済み/自動)のスナップショットカード列を組み立てる。0件なら「なし」を出す。
function buildSnapshotList(
  list: readonly SnapshotMeta[], slot: SaveSlotMeta, loadable: boolean, callbacks: SnapshotPaneCallbacks,
): HTMLElement {
  const el = document.createElement('div');
  el.className = 'sb-snapshot-list';
  // 0件なら一覧の代わりに「なし」とだけ出す。
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

// 1件のスナップショットカードを組み立てる。ダブルクリックでロードを、右側のボタンで
// クリップ切替・改名・削除・分岐を、それぞれコールバックへ委ねる。
function buildSnapshotCard(
  s: SnapshotMeta, slot: SaveSlotMeta, loadable: boolean, callbacks: SnapshotPaneCallbacks,
): HTMLElement {
  // 取り込んだファイル由来のメタは欠けていたり別物だったりし得るので、表示前に必ず均す。
  const kind = SNAPSHOT_KIND_LABEL[s.kind] ? s.kind : 'auto';
  const hpPct = Math.max(0, Math.min(100, num(s.hpRatio) * 100));
  const loadTitle = loadable
    ? 'ダブルクリックでロード'
    : 'いま遊んでいるセーブデータ・ステージのスナップショットだけを復元できます';

  const card = document.createElement('div');
  card.className = 'sb-snap-card';
  card.classList.toggle('sb-snap-loadable', loadable);
  card.title = loadTitle;
  // ボタンの click は自身で止まるが dblclick は素通りするので、カード自身の判定で弾く。
  card.addEventListener('dblclick', (e) => {
    if ((e.target as HTMLElement).closest('.w-btn')) return;
    callbacks.onLoadSnapshot(s.id, loadable);
  });

  const head = document.createElement('div');
  head.className = 'sb-snap-head';
  const name = document.createElement('span');
  name.className = 'sb-snap-name';
  name.textContent = String(s.name ?? '');
  const badge = document.createElement('span');
  badge.className = `sb-snap-badge sb-snap-badge-${kind}`;
  badge.textContent = SNAPSHOT_KIND_LABEL[kind];
  head.append(name, badge);
  card.appendChild(head);

  const row1 = document.createElement('div');
  row1.className = 'sb-snap-row';
  row1.textContent = `MET ${fmtTime(num(s.simTime))} / ${fmtDateTime(num(s.createdAtReal) / 1000)}`;
  card.appendChild(row1);

  const row2 = document.createElement('div');
  row2.className = 'sb-snap-row';
  row2.textContent = `${celestialBodyName(s.centerBodyId)} 高度 ${fmtDist(num(s.altitude))} / 速度 ${fmtSpeed(num(s.speed))}`;
  card.appendChild(row2);

  // このパネルの主役はセーブ操作であって HP 表示ではないため、常にモノトーンで塗る(danger 色は使わない)。
  const hpMeter = new Meter();
  hpMeter.element.classList.add('sb-snap-hp-meter');
  hpMeter.setRatio(hpPct / 100);
  card.appendChild(hpMeter.element);

  const row3 = document.createElement('div');
  row3.className = 'sb-snap-row';
  row3.textContent = `艦 ${num(s.playerCount)} / 敵残 ${num(s.enemyAliveCount)} / 所持金 ${num(s.money).toLocaleString()} Cr`;
  card.appendChild(row3);

  const actions = document.createElement('div');
  actions.className = 'sb-snap-actions';
  const pinBtn = new Button(s.pinned ? '📌 解除' : '📌 クリップ', () => callbacks.onTogglePin(s.id, s.pinned));
  pinBtn.element.classList.add('sb-btn', 'sb-btn-sm', 'sb-btn-pin');
  pinBtn.setOn(s.pinned);
  actions.appendChild(pinBtn.element);
  actions.appendChild(smallBtn('✎', '名前変更', () => callbacks.onRenameSnapshot(s.id)));
  actions.appendChild(smallBtn('🗑', '削除', () => callbacks.onDeleteSnapshot(s.id)));
  actions.appendChild(smallBtn('⑂', 'ここから分岐', () => callbacks.onBranch(slot.id, s.id)));
  card.appendChild(actions);

  return card;
}
