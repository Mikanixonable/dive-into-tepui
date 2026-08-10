// セーブデータブラウザ: 複数のセーブデータ(スロット)とそのスナップショット履歴を
// 一覧・切替・クリップ・書き出し/取り込みするフルスクリーン UI。
// DockView と同じく一発モーダルで、操作のたびに innerHTML を組み直す(毎フレーム sync は無い)。
import type { Game } from '../game';
import { SaveSlots, AUTO_SNAPSHOT_LIMIT, PINNED_SNAPSHOT_LIMIT } from '../save/save-slots';
import { SnapshotService } from '../save/snapshot-service';
import { exportSlotToFile, pickAndImportSlot } from '../save/save-transfer';
import type { SaveSlotMeta, SnapshotMeta } from '../save-data';
import { fmtDist, fmtSpeed, fmtTime, fmtDateTime } from './utils';
import { celestialBodyName } from './frame-labels';
import { syncHudModalState } from './dom';

// スロット名・スナップショット名はプレイヤーの入力と取り込んだファイル由来なので、
// innerHTML へ差し込む前に必ずこれを通す。
function esc(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

// 数値であるはずのメタ項目。取り込んだファイルでは欠けていることがあり、そのまま
// 書式化関数へ渡すと一覧の組み立てごと落ちてイベント配線まで届かなくなる。
function num(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

const SNAPSHOT_KIND_LABEL: Record<SnapshotMeta['kind'], string> = {
  auto: '自動', manual: '手動', checkpoint: '決着',
};

export class SaveBrowser {
  private readonly el: HTMLElement;
  private _visible = false;
  // 一覧で選んで「見ている」スロット。アクティブスロット(実際に遊んでいるもの)とは独立。
  private viewedSlotId: string | null = null;
  private viewedStageId: string | null = null;
  private statusLine = '';
  private statusIsError = false;

  // ページ再読込などスロット切替の実処理は呼び出し側が行う。
  onSlotSwitched: (() => void) | null = null;

  get visible(): boolean { return this._visible; }

  constructor(
    root: HTMLElement,
    private readonly slots: SaveSlots,
    private readonly service: SnapshotService,
    private readonly game: Game,
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
    syncHudModalState();
  }

  close(): void {
    this.el.style.display = 'none';
    this._visible = false;
    this.game.resume();
    syncHudModalState();
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
    this.el.innerHTML = `
      <div class="sb-panel">
        <div class="sb-header">
          <span class="sb-title">SAVE BROWSER</span>
          <button class="sb-close-btn" id="sb-close">✕</button>
        </div>
        <div class="sb-body">
          <div class="sb-pane sb-pane-slots">
            <div class="sb-pane-title">セーブデータ</div>
            <div class="sb-slot-list">${this.slots.slots.map((s) => this.buildSlotRow(s)).join('') || '<div class="sb-empty">セーブデータがありません。</div>'}</div>
            <div class="sb-slot-footer">
              <button class="sb-btn" id="sb-new-slot">新しいセーブデータ</button>
              <button class="sb-btn" id="sb-import-slot">ファイルから取り込む</button>
            </div>
          </div>
          <div class="sb-pane sb-pane-snapshots">
            ${this.buildSnapshotPane()}
          </div>
        </div>
        <div class="sb-status ${this.statusIsError ? 'error' : ''}">${this.statusLine}</div>
      </div>
    `;
    this.attachEvents();
  }

  private buildSlotRow(s: SaveSlotMeta): string {
    const totalSnapshots = s.stages.reduce((sum, h) => sum + h.snapshots.length, 0);
    const active = s.id === this.slots.activeSlotId;
    const viewed = s.id === this.viewedSlotId;
    return `
      <div class="sb-slot-row ${viewed ? 'viewed' : ''} ${active ? 'active' : ''}" data-slot-id="${s.id}">
        <div class="sb-slot-info">
          <span class="sb-slot-name">${esc(s.name)}${active ? ' ▶' : ''}</span>
          <span class="sb-slot-meta">${s.lastStageId === '' ? '未プレイ' : s.mode === 'stage' ? 'ステージ' : 'クリエイティブ'} / ${fmtDateTime(s.lastPlayedAtReal / 1000)} / ${totalSnapshots}件</span>
        </div>
        <div class="sb-slot-actions">
          <button class="sb-btn sb-btn-sm" data-act="rename" data-slot-id="${s.id}" title="名前変更">✎</button>
          <button class="sb-btn sb-btn-sm" data-act="duplicate" data-slot-id="${s.id}" title="複製">⎘</button>
          <button class="sb-btn sb-btn-sm" data-act="export" data-slot-id="${s.id}" title="書き出し">⇩</button>
          <button class="sb-btn sb-btn-sm" data-act="delete" data-slot-id="${s.id}" title="削除">🗑</button>
          ${active ? '' : `<button class="sb-btn sb-btn-sm sb-btn-play" data-act="play" data-slot-id="${s.id}">このデータで遊ぶ</button>`}
        </div>
      </div>
    `;
  }

  // 右ペイン: 表示対象スロットのステージ履歴タブとスナップショット一覧を組む。
  private buildSnapshotPane(): string {
    const slot = this.viewedSlot();
    if (!slot) return `<div class="sb-empty">左の一覧からセーブデータを選んでください。</div>`;
    const stageId = this.viewedStageId ?? slot.stages[0]?.stageId ?? null;
    const history = stageId ? slot.stages.find((h) => h.stageId === stageId) ?? null : null;

    const tabs = slot.stages.length <= 1 ? '' : `
      <div class="sb-stage-tabs">
        ${slot.stages.map((h) => `<button class="sb-tab-btn ${h.stageId === stageId ? 'active' : ''}" data-stage-id="${esc(h.stageId)}">${esc(h.stageId)}</button>`).join('')}
      </div>
    `;

    const pinned = history ? history.snapshots.filter((s) => s.pinned) : [];
    const auto = history ? history.snapshots.filter((s) => !s.pinned) : [];
    // 復元できるのは、いま遊んでいるスロットの、いま遊んでいるステージのものだけ。
    const loadable = slot.id === this.slots.activeSlotId && stageId === this.game.activeStage.id;

    return `
      <div class="sb-pane-title">スナップショット</div>
      <button class="sb-btn" id="sb-capture-now" ${this.canCaptureNow() ? '' : 'disabled'} title="${this.canCaptureNow() ? '' : '決着後の状態は復元できないため残せません'}">今の状態をクリップして残す</button>
      ${tabs}
      <div class="sb-snapshot-groups">
        <div class="sb-snapshot-group-title">クリップ済み (${pinned.length}/${PINNED_SNAPSHOT_LIMIT})</div>
        <div class="sb-snapshot-list">${pinned.map((s) => this.buildSnapshotCard(s, slot, loadable)).join('') || '<div class="sb-empty">なし</div>'}</div>
        <div class="sb-snapshot-group-title">自動 (${auto.length}/${AUTO_SNAPSHOT_LIMIT}・古い順に消えます)</div>
        <div class="sb-snapshot-list">${auto.map((s) => this.buildSnapshotCard(s, slot, loadable)).join('') || '<div class="sb-empty">なし</div>'}</div>
      </div>
    `;
  }

  private buildSnapshotCard(s: SnapshotMeta, slot: SaveSlotMeta, loadable: boolean): string {
    // 取り込んだファイル由来のメタは欠けていたり別物だったりし得るので、表示前に必ず均す。
    const kind = SNAPSHOT_KIND_LABEL[s.kind] ? s.kind : 'auto';
    const hpPct = Math.max(0, Math.min(100, num(s.hpRatio) * 100));
    const loadTitle = loadable
      ? 'ダブルクリックでロード'
      : 'いま遊んでいるセーブデータ・ステージのスナップショットだけを復元できます';
    return `
      <div class="sb-snap-card ${loadable ? 'sb-snap-loadable' : ''}" data-snap-id="${s.id}" data-loadable="${loadable}" title="${loadTitle}">
        <div class="sb-snap-head">
          <span class="sb-snap-name">${esc(String(s.name ?? ''))}</span>
          <span class="sb-snap-badge sb-snap-badge-${kind}">${SNAPSHOT_KIND_LABEL[kind]}</span>
        </div>
        <div class="sb-snap-row">MET ${fmtTime(num(s.simTime))} / ${fmtDateTime(num(s.createdAtReal) / 1000)}</div>
        <div class="sb-snap-row">${esc(celestialBodyName(s.centerBodyId))} 高度 ${fmtDist(num(s.altitude))} / 速度 ${fmtSpeed(num(s.speed))}</div>
        <div class="sb-snap-hp-bar"><div class="sb-snap-hp-fill" style="width:${hpPct}%"></div></div>
        <div class="sb-snap-row">艦 ${num(s.playerCount)} / 敵残 ${num(s.enemyAliveCount)} / 所持金 ${num(s.money).toLocaleString()} Cr</div>
        <div class="sb-snap-actions">
          <button class="sb-btn sb-btn-sm sb-btn-pin" data-snap-id="${s.id}" data-pinned="${s.pinned}">${s.pinned ? '📌 解除' : '📌 クリップ'}</button>
          <button class="sb-btn sb-btn-sm" data-act="rename-snap" data-snap-id="${s.id}" title="名前変更">✎</button>
          <button class="sb-btn sb-btn-sm" data-act="delete-snap" data-snap-id="${s.id}" title="削除">🗑</button>
          <button class="sb-btn sb-btn-sm" data-act="branch" data-slot-id="${slot.id}" data-snap-id="${s.id}" title="ここから分岐">⑂</button>
        </div>
      </div>
    `;
  }

  private attachEvents(): void {
    this.el.querySelector('#sb-close')?.addEventListener('click', () => this.close());

    this.el.querySelectorAll('.sb-slot-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        this.viewedSlotId = (row as HTMLElement).dataset['slotId'] ?? null;
        this.viewedStageId = null;
        this.rebuild();
      });
    });

    this.el.querySelectorAll('[data-act="rename"]').forEach((b) => b.addEventListener('click', (e) => this.handleRenameSlot(e)));
    this.el.querySelectorAll('[data-act="duplicate"]').forEach((b) => b.addEventListener('click', (e) => this.handleDuplicateSlot(e)));
    this.el.querySelectorAll('[data-act="export"]').forEach((b) => b.addEventListener('click', (e) => this.handleExportSlot(e)));
    this.el.querySelectorAll('[data-act="delete"]').forEach((b) => b.addEventListener('click', (e) => this.handleDeleteSlot(e)));
    this.el.querySelectorAll('[data-act="play"]').forEach((b) => b.addEventListener('click', (e) => this.handlePlaySlot(e)));
    this.el.querySelector('#sb-new-slot')?.addEventListener('click', () => this.handleNewSlot());
    this.el.querySelector('#sb-import-slot')?.addEventListener('click', () => this.handleImportSlot());

    this.el.querySelectorAll('.sb-tab-btn').forEach((b) => {
      b.addEventListener('click', () => {
        this.viewedStageId = (b as HTMLElement).dataset['stageId'] ?? null;
        this.rebuild();
      });
    });
    this.el.querySelector('#sb-capture-now')?.addEventListener('click', () => this.handleCaptureNow());
    this.el.querySelectorAll('.sb-snap-card').forEach((card) => card.addEventListener('dblclick', (e) => this.handleLoadSnapshot(e)));
    this.el.querySelectorAll('.sb-btn-pin').forEach((b) => b.addEventListener('click', (e) => this.handleTogglePin(e)));
    this.el.querySelectorAll('[data-act="rename-snap"]').forEach((b) => b.addEventListener('click', (e) => this.handleRenameSnapshot(e)));
    this.el.querySelectorAll('[data-act="delete-snap"]').forEach((b) => b.addEventListener('click', (e) => this.handleDeleteSnapshot(e)));
    this.el.querySelectorAll('[data-act="branch"]').forEach((b) => b.addEventListener('click', (e) => this.handleBranch(e)));
  }

  private handleRenameSlot(e: Event): void {
    const id = (e.target as HTMLElement).dataset['slotId'];
    const slot = this.slots.slots.find((s) => s.id === id);
    if (!id || !slot) return;
    const name = prompt('セーブデータの名前', slot.name);
    if (!name) return;
    this.slots.renameSlot(id, name);
    this.rebuild();
  }

  private handleDuplicateSlot(e: Event): void {
    const id = (e.target as HTMLElement).dataset['slotId'];
    const slot = this.slots.slots.find((s) => s.id === id);
    if (!id || !slot) return;
    const dup = this.slots.duplicateSlot(id);
    if (dup) this.viewedSlotId = dup.id;
    this.rebuild();
  }

  private handleExportSlot(e: Event): void {
    const id = (e.target as HTMLElement).dataset['slotId'];
    if (!id) return;
    const pinnedOnly = confirm('クリップ済みのスナップショットだけを書き出しますか?(キャンセルで全件)');
    const ok = exportSlotToFile(this.slots, id, pinnedOnly);
    this.setStatus(ok ? '書き出しました。' : '書き出しに失敗しました。', !ok);
    this.rebuild();
  }

  private handleDeleteSlot(e: Event): void {
    const id = (e.target as HTMLElement).dataset['slotId'];
    const slot = this.slots.slots.find((s) => s.id === id);
    if (!id || !slot) return;
    if (!confirm(`「${slot.name}」を削除します。よろしいですか?`)) return;
    this.slots.deleteSlot(id);
    if (this.viewedSlotId === id) this.viewedSlotId = this.slots.activeSlotId;
    this.rebuild();
  }

  private handlePlaySlot(e: Event): void {
    const id = (e.target as HTMLElement).dataset['slotId'];
    if (!id) return;
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

  private handleLoadSnapshot(e: Event): void {
    if ((e.target as HTMLElement).closest('button')) return;
    const card = e.currentTarget as HTMLElement;
    const snapId = card.dataset['snapId'];
    if (!snapId) return;
    if (card.dataset['loadable'] !== 'true') {
      this.setStatus('いま遊んでいるセーブデータ・ステージのスナップショットだけを復元できます。', true);
      this.rebuild();
      return;
    }
    const ok = this.service.restore(this.game, snapId);
    if (ok) {
      this.close();
    } else {
      this.setStatus('ロードに失敗しました。', true);
      this.rebuild();
    }
  }

  // クリップ時は名前を尋ね、解除時はそのまま外す。
  private handleTogglePin(e: Event): void {
    const btn = e.target as HTMLElement;
    const snapId = btn.dataset['snapId'];
    const currentlyPinned = btn.dataset['pinned'] === 'true';
    if (!snapId) return;
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

  private handleRenameSnapshot(e: Event): void {
    const id = (e.target as HTMLElement).dataset['snapId'];
    if (!id) return;
    const name = prompt('スナップショットの名前', '');
    if (!name) return;
    this.slots.renameSnapshot(id, name);
    this.rebuild();
  }

  private handleDeleteSnapshot(e: Event): void {
    const id = (e.target as HTMLElement).dataset['snapId'];
    if (!id) return;
    if (!confirm('このスナップショットを削除します。よろしいですか?')) return;
    this.slots.deleteSnapshot(id);
    this.rebuild();
  }

  private handleBranch(e: Event): void {
    const btn = e.target as HTMLElement;
    const slotId = btn.dataset['slotId'];
    const snapId = btn.dataset['snapId'];
    if (!slotId || !snapId) return;
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
