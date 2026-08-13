// セーブデータブラウザ: 複数のセーブデータ(スロット)とそのスナップショット履歴を
// 一覧・切替・クリップ・書き出し/取り込みするフルスクリーン UI。
// DockView と同じく一発モーダルで、操作のたびに DOM を組み直す(毎フレーム sync は無い)。
import type { Game } from '../game';
import { SaveSlots, AUTO_SNAPSHOT_LIMIT, PINNED_SNAPSHOT_LIMIT } from '../save/save-slots';
import { SnapshotService } from '../save/snapshot-service';
import { exportSlotToFile, pickAndImportSlot } from '../save/save-transfer';
import type { SaveSlotMeta, SnapshotMeta } from '../save-data';
import { fmtDist, fmtSpeed, fmtTime, fmtDateTime } from './utils';
import { celestialBodyName } from './frame-labels';
import type { OverlayHandle, OverlayManager } from './overlay-manager';
import { findStageClass } from '../stages/stage-dictionary';
import { Button, CloseButton, Meter, TabBar } from './widgets';

// ステージ id を選択画面と同じ表示名にする。登録の無い id はそのまま出す。
function stageLabel(stageId: string): string {
  return findStageClass(stageId)?.selectLabel ?? stageId;
}

// 数値であるはずのメタ項目。取り込んだファイルでは欠けていることがあり、そのまま
// 書式化関数へ渡すと一覧の組み立てごと落ちてイベント配線まで届かなくなる。
function num(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

const SNAPSHOT_KIND_LABEL: Record<SnapshotMeta['kind'], string> = {
  auto: '自動', manual: '手動', checkpoint: '決着',
};

export class SaveBrowser implements OverlayHandle {
  private readonly el: HTMLElement;
  private _visible = false;
  // 一覧で選んで「見ている」スロット。アクティブスロット(実際に遊んでいるもの)とは独立。
  private viewedSlotId: string | null = null;
  private viewedStageId: string | null = null;
  private statusLine = '';
  private statusIsError = false;

  // ページ再読込などスロット切替の実処理は呼び出し側が行う。
  onSlotSwitched: (() => void) | null = null;
  // スナップショットのロードは Game を作り直すことで表現するため、実処理は呼び出し側が行う。
  onLoadSnapshot: ((snapshotId: string) => void) | null = null;

  get visible(): boolean { return this._visible; }

  constructor(
    root: HTMLElement,
    private readonly slots: SaveSlots,
    private readonly service: SnapshotService,
    private readonly game: Game,
    private readonly overlayManager: OverlayManager,
  ) {
    this.el = document.createElement('div');
    this.el.id = 'save-browser';
    this.el.style.display = 'none';
    root.appendChild(this.el);
  }

  // パネルを開く。表示対象スロットは既定でアクティブスロット。開いている間はゲームを止める。
  open(): void {
    this.viewedSlotId = this.slots.activeSlotId;
    this.viewedStageId = null;
    this.statusLine = '';
    this.statusIsError = false;
    this.rebuild();
    this.el.style.display = 'flex';
    this._visible = true;
    this.game.pause();
    this.overlayManager.open('save-browser', this, {
      kind: 'modal', closeOnEscape: true, closeOnOutsideClick: false, gatesInput: true, exclusiveGroup: 'system-modal',
    });
  }

  close(): void {
    this.el.style.display = 'none';
    this._visible = false;
    this.game.resume();
    this.overlayManager.close('save-browser');
  }

  contains(target: Node): boolean {
    return this.el.contains(target);
  }

  private setStatus(text: string, isError: boolean): void {
    this.statusLine = text;
    this.statusIsError = isError;
  }

  // 決着後(won/lost/timeup)の状態は復元しても操作不能なので撮らせない([F5] と同条件)。
  private canCaptureNow(): boolean {
    return this.viewedSlotId === this.slots.activeSlotId && this.game.activeStage.isPlaying;
  }

  private viewedSlot(): SaveSlotMeta | null {
    return this.slots.slots.find((s) => s.id === this.viewedSlotId) ?? null;
  }

  // 現在のスロット一覧・スナップショット一覧を組み直して DOM に反映する。
  private rebuild(): void {
    this.el.innerHTML = '';
    const panel = document.createElement('div');
    panel.className = 'sb-panel';

    const header = document.createElement('div');
    header.className = 'sb-header';
    const title = document.createElement('span');
    title.className = 'sb-title';
    title.textContent = 'SAVE BROWSER';
    header.appendChild(title);
    const closeBtn = new CloseButton(() => this.close());
    header.appendChild(closeBtn.element);
    panel.appendChild(header);

    const body = document.createElement('div');
    body.className = 'sb-body';
    body.appendChild(this.buildSlotsPane());
    const snapPane = document.createElement('div');
    snapPane.className = 'sb-pane sb-pane-snapshots';
    snapPane.appendChild(this.buildSnapshotPane());
    body.appendChild(snapPane);
    panel.appendChild(body);

    const status = document.createElement('div');
    status.className = 'sb-status';
    status.classList.toggle('error', this.statusIsError);
    status.textContent = this.statusLine;
    panel.appendChild(status);

    this.el.appendChild(panel);
  }

  private buildSlotsPane(): HTMLElement {
    const pane = document.createElement('div');
    pane.className = 'sb-pane sb-pane-slots';
    const title = document.createElement('div');
    title.className = 'sb-pane-title';
    title.textContent = 'セーブデータ';
    pane.appendChild(title);

    const list = document.createElement('div');
    list.className = 'sb-slot-list';
    if (this.slots.slots.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sb-empty';
      empty.textContent = 'セーブデータがありません。';
      list.appendChild(empty);
    } else {
      for (const s of this.slots.slots) list.appendChild(this.buildSlotRow(s));
    }
    pane.appendChild(list);

    const footer = document.createElement('div');
    footer.className = 'sb-slot-footer';
    footer.appendChild(this.mainBtn('新しいセーブデータ', () => this.handleNewSlot()));
    footer.appendChild(this.mainBtn('ファイルから取り込む', () => this.handleImportSlot()));
    pane.appendChild(footer);
    return pane;
  }

  private buildSlotRow(s: SaveSlotMeta): HTMLElement {
    const totalSnapshots = s.stages.reduce((sum, h) => sum + h.snapshots.length, 0);
    const active = s.id === this.slots.activeSlotId;
    const viewed = s.id === this.viewedSlotId;

    const row = document.createElement('div');
    row.className = 'sb-slot-row';
    row.classList.toggle('viewed', viewed);
    row.classList.toggle('on', active);
    row.addEventListener('click', () => {
      this.viewedSlotId = s.id;
      this.viewedStageId = null;
      this.rebuild();
    });

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

    const actions = document.createElement('div');
    actions.className = 'sb-slot-actions';
    actions.appendChild(this.smallBtn('✎', '名前変更', () => this.handleRenameSlot(s.id)));
    actions.appendChild(this.smallBtn('⎘', '複製', () => this.handleDuplicateSlot(s.id)));
    actions.appendChild(this.smallBtn('⇩', '書き出し', () => this.handleExportSlot(s.id)));
    actions.appendChild(this.smallBtn('🗑', '削除', () => this.handleDeleteSlot(s.id)));
    if (!active) {
      const playBtn = new Button('このデータで遊ぶ', () => this.handlePlaySlot(s.id));
      playBtn.element.classList.add('sb-btn', 'sb-btn-sm', 'sb-btn-play');
      actions.appendChild(playBtn.element);
    }
    row.appendChild(actions);
    return row;
  }

  // 右ペイン: 表示対象スロットのステージ履歴タブとスナップショット一覧を組む。
  private buildSnapshotPane(): HTMLElement {
    const wrap = document.createElement('div');
    const slot = this.viewedSlot();
    if (!slot) {
      const empty = document.createElement('div');
      empty.className = 'sb-empty';
      empty.textContent = '左の一覧からセーブデータを選んでください。';
      wrap.appendChild(empty);
      return wrap;
    }
    const stageId = this.viewedStageId ?? slot.stages[0]?.stageId ?? null;
    const history = stageId ? slot.stages.find((h) => h.stageId === stageId) ?? null : null;

    const title = document.createElement('div');
    title.className = 'sb-pane-title';
    title.textContent = 'スナップショット';
    wrap.appendChild(title);

    const captureBtn = new Button('今の状態をクリップして残す', () => this.handleCaptureNow());
    captureBtn.element.id = 'sb-capture-now';
    captureBtn.element.classList.add('sb-btn');
    captureBtn.setEnabled(this.canCaptureNow());
    captureBtn.element.title = this.canCaptureNow() ? '' : '決着後の状態は復元できないため残せません';
    wrap.appendChild(captureBtn.element);

    if (slot.stages.length > 1) {
      const tabsWrap = document.createElement('div');
      tabsWrap.className = 'sb-stage-tabs';
      const tabBar = new TabBar<string>(
        slot.stages.map((h) => [h.stageId, stageLabel(h.stageId)] as const),
        (id) => { this.viewedStageId = id; this.rebuild(); },
      );
      tabBar.setSelected(stageId ?? '');
      tabsWrap.appendChild(tabBar.element);
      wrap.appendChild(tabsWrap);
    }

    const pinned = history ? history.snapshots.filter((s) => s.pinned) : [];
    const auto = history ? history.snapshots.filter((s) => !s.pinned) : [];
    // 復元できるのは、いま遊んでいるスロットの、いま遊んでいるステージのものだけ。
    const loadable = slot.id === this.slots.activeSlotId && stageId === this.game.activeStage.id;

    const groups = document.createElement('div');
    groups.className = 'sb-snapshot-groups';
    const pinnedTitle = document.createElement('div');
    pinnedTitle.className = 'sb-snapshot-group-title';
    pinnedTitle.textContent = `クリップ済み (${pinned.length}/${PINNED_SNAPSHOT_LIMIT})`;
    groups.appendChild(pinnedTitle);
    groups.appendChild(this.buildSnapshotList(pinned, slot, loadable));
    const autoTitle = document.createElement('div');
    autoTitle.className = 'sb-snapshot-group-title';
    autoTitle.textContent = `自動 (${auto.length}/${AUTO_SNAPSHOT_LIMIT}・古い順に消えます)`;
    groups.appendChild(autoTitle);
    groups.appendChild(this.buildSnapshotList(auto, slot, loadable));
    wrap.appendChild(groups);
    return wrap;
  }

  private buildSnapshotList(list: readonly SnapshotMeta[], slot: SaveSlotMeta, loadable: boolean): HTMLElement {
    const el = document.createElement('div');
    el.className = 'sb-snapshot-list';
    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sb-empty';
      empty.textContent = 'なし';
      el.appendChild(empty);
      return el;
    }
    for (const s of list) el.appendChild(this.buildSnapshotCard(s, slot, loadable));
    return el;
  }

  private buildSnapshotCard(s: SnapshotMeta, slot: SaveSlotMeta, loadable: boolean): HTMLElement {
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
      this.handleLoadSnapshot(s.id, loadable);
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

    // このパネルの主役はセーブ操作であって HP 表示ではないため、常にモノトーンで塗る
    // (danger 色は使わない — dom.ts の .sb-snap-hp-meter が塗り色を上書きする)。
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
    const pinBtn = new Button(s.pinned ? '📌 解除' : '📌 クリップ', () => this.handleTogglePin(s.id, s.pinned));
    pinBtn.element.classList.add('sb-btn', 'sb-btn-sm', 'sb-btn-pin');
    pinBtn.setOn(s.pinned);
    actions.appendChild(pinBtn.element);
    actions.appendChild(this.smallBtn('✎', '名前変更', () => this.handleRenameSnapshot(s.id)));
    actions.appendChild(this.smallBtn('🗑', '削除', () => this.handleDeleteSnapshot(s.id)));
    actions.appendChild(this.smallBtn('⑂', 'ここから分岐', () => this.handleBranch(slot.id, s.id)));
    card.appendChild(actions);

    return card;
  }

  // .sb-btn の主要ボタン(横幅いっぱい・文言そのまま)を組む。
  private mainBtn(label: string, onClick: () => void): HTMLElement {
    const btn = new Button(label, onClick);
    btn.element.classList.add('sb-btn');
    return btn.element;
  }

  // .sb-btn.sb-btn-sm の小型アイコンボタンを組む。title はホバー説明とタッチ向け aria-label の両方に使う。
  private smallBtn(glyph: string, title: string, onClick: () => void): HTMLElement {
    const btn = new Button(glyph, onClick);
    btn.element.classList.add('sb-btn', 'sb-btn-sm');
    btn.element.title = title;
    btn.element.setAttribute('aria-label', title);
    return btn.element;
  }

  private handleRenameSlot(id: string): void {
    const slot = this.slots.slots.find((s) => s.id === id);
    if (!slot) return;
    const name = prompt('セーブデータの名前', slot.name);
    if (!name) return;
    this.slots.renameSlot(id, name);
    this.rebuild();
  }

  private handleDuplicateSlot(id: string): void {
    const slot = this.slots.slots.find((s) => s.id === id);
    if (!slot) return;
    const dup = this.slots.duplicateSlot(id);
    if (dup) this.viewedSlotId = dup.id;
    this.rebuild();
  }

  private handleExportSlot(id: string): void {
    const pinnedOnly = confirm('クリップ済みのスナップショットだけを書き出しますか?(キャンセルで全件)');
    const ok = exportSlotToFile(this.slots, id, pinnedOnly);
    this.setStatus(ok ? '書き出しました。' : '書き出しに失敗しました。', !ok);
    this.rebuild();
  }

  private handleDeleteSlot(id: string): void {
    const slot = this.slots.slots.find((s) => s.id === id);
    if (!slot) return;
    if (!confirm(`「${slot.name}」を削除します。よろしいですか?`)) return;
    this.slots.deleteSlot(id);
    if (this.viewedSlotId === id) this.viewedSlotId = this.slots.activeSlotId;
    this.rebuild();
  }

  private handlePlaySlot(id: string): void {
    this.slots.setActiveSlot(id);
    this.onSlotSwitched?.();
  }

  // モードとステージはまだ決まらない(タイトル画面で選ぶ)ので、空のスロットだけを作って
  // アクティブにする。実際に何を遊んだかは開始時に SaveSlots.noteLaunch が書き込む。
  private handleNewSlot(): void {
    const name = prompt('新しいセーブデータの名前', '新しいセーブデータ');
    if (!name) return;
    const slot = this.slots.createSlot(name);
    this.slots.setActiveSlot(slot.id);
    this.onSlotSwitched?.();
  }

  private async handleImportSlot(): Promise<void> {
    const result = await pickAndImportSlot(this.slots);
    if (result.ok) {
      this.viewedSlotId = result.slot.id;
      this.setStatus('取り込みました。', false);
    } else {
      this.setStatus(`取り込みに失敗しました: ${result.reason}`, true);
    }
    this.rebuild();
  }

  private handleCaptureNow(): void {
    if (!this.canCaptureNow()) return;
    const name = prompt('スナップショットの名前', '');
    const snap = this.service.capture(this.game, 'manual', name || null, true);
    this.setStatus(snap ? 'クリップしました。' : 'クリップに失敗しました。', !snap);
    this.rebuild();
  }

  private handleLoadSnapshot(snapId: string, loadable: boolean): void {
    if (!loadable) {
      this.setStatus('いま遊んでいるセーブデータ・ステージのスナップショットだけを復元できます。', true);
      this.rebuild();
      return;
    }
    this.onLoadSnapshot?.(snapId);
  }

  // クリップ時は名前を尋ね、解除時はそのまま外す。
  private handleTogglePin(snapId: string, currentlyPinned: boolean): void {
    if (currentlyPinned) {
      this.slots.setPinned(snapId, false);
      this.rebuild();
      return;
    }
    const ok = this.slots.setPinned(snapId, true);
    if (!ok) {
      this.setStatus('クリップ上限です。先にどれかのクリップを外してください。', true);
      this.rebuild();
      return;
    }
    const name = prompt('クリップする名前(空欄なら変更しません)', '');
    if (name) this.slots.renameSnapshot(snapId, name);
    this.rebuild();
  }

  private handleRenameSnapshot(id: string): void {
    const name = prompt('スナップショットの名前', '');
    if (!name) return;
    this.slots.renameSnapshot(id, name);
    this.rebuild();
  }

  private handleDeleteSnapshot(id: string): void {
    if (!confirm('このスナップショットを削除します。よろしいですか?')) return;
    this.slots.deleteSnapshot(id);
    this.rebuild();
  }

  private handleBranch(slotId: string, snapId: string): void {
    const dup = this.slots.duplicateSlot(slotId, snapId);
    if (dup) {
      this.viewedSlotId = dup.id;
      this.setStatus('分岐しました。', false);
    } else {
      this.setStatus('分岐に失敗しました。', true);
    }
    this.rebuild();
  }

  dispose(): void {
    this.el.remove();
  }
}
