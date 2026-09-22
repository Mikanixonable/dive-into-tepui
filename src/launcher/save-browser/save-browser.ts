// セーブデータブラウザ: 複数のセーブデータ(スロット)とその手動セーブの履歴を
// 一覧・切替・クリップ・書き出し/取り込みするフルスクリーン UI。
import { solarSystemBodyName } from '../../game/celestial/solar-system/solar-system';
import type { SaveSlots } from '../save/save-slots';
import type { SnapshotService, SnapshotSource } from '../save/snapshot-service';
import { exportSlotToFile, pickAndImportSlot } from '../save/save-transfer';
import type { SaveSlotMeta } from '../save/slot-data';
import type { OverlayHandle, OverlayManager } from '../../hud/overlay-manager';
import { CloseButton, TabBar } from '../../hud/widgets';
import { injectOnce } from '../../hud/inject-style';
import { injectCommonUiStyle } from '../../hud/style/common-ui-style';
import { MQ_COMPACT } from '../../hud/breakpoints';
import { buildSlotsPane } from './slot-pane';
import { buildSnapshotPane } from './snapshot-pane';

const STYLE = `
#save-browser {
  position: fixed; inset: 0; display: none;
  align-items: center; justify-content: center;
  background: var(--scrim); backdrop-filter: blur(3px);
  font-family: var(--font-family); pointer-events: auto;
}
#save-browser .sb-panel {
  width: min(1100px, 94vw); height: min(760px, 88vh); height: min(760px, 88dvh);
  display: flex; flex-direction: column; overflow: hidden;
  border-radius: var(--radius-window);
}
#save-browser .sb-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: var(--space-5) var(--space-6); flex: 0 0 auto;
}
#save-browser .sb-title { font-size: var(--font-l); font-weight: 700; letter-spacing: 0.12em; color: var(--text); }
#save-browser .sb-body { flex: 1 1 0; min-height: 0; display: flex; gap: var(--space-1); background: var(--glass-inset); }
#save-browser .sb-pane {
  flex: 1 1 0; min-width: 0; overflow-y: auto; padding: var(--space-5) var(--space-5);
  display: flex; flex-direction: column; gap: var(--space-3); background: var(--glass-inset);
  scrollbar-width: thin;
}
#save-browser .sb-pane-title { font-size: var(--font-xs); letter-spacing: 1.5px; color: var(--text-dim); }
#save-browser .sb-empty { color: var(--text-dim); padding: var(--space-5); text-align: center; line-height: 1.7; font-size: var(--font-s); }
#save-browser .sb-status { min-height: 20px; padding: var(--space-2) var(--space-5); font-size: var(--font-xs); color: var(--text-dim); }
#save-browser .sb-status.error { color: var(--color-error); }
/* compact: 左右ペインのうち、sb-mobile-tabs で選んだ片方を表示する。 */
#save-browser .sb-mobile-tabs { display: none; padding: var(--space-3) var(--space-5) 0; }
@media ${MQ_COMPACT} {
  #save-browser .sb-panel { width: 100vw; height: 100vh; height: 100dvh; border-radius: 0; }
  #save-browser .sb-mobile-tabs { display: flex; }
  #save-browser .sb-body { flex-direction: column; }
  #save-browser .sb-pane:not(.sb-pane-mobile-active) { display: none; }
}
`;

// いま動いている周回の読み口。周回が無ければ current は null。
export interface CurrentGameSource {
  readonly current: {
    readonly stageId: string;
    readonly nameOfBody: (id: string) => string;
    readonly snapshot: SnapshotSource;
  } | null;
}

export class SaveBrowser implements OverlayHandle {
  private readonly el: HTMLElement;
  private _visible = false;
  // 一覧で選んで「見ている」スロット。アクティブスロット(実際に遊んでいるもの)とは独立。
  private viewedSlotId: string | null = null;
  private viewedStageId: string | null = null;
  private statusLine = '';
  private statusIsError = false;
  // compact 幅でだけ、左右ペインのどちらを表示するか(タブで切り替える)。
  private mobilePane: 'slots' | 'snapshots' = 'slots';

  // アクティブスロットを切り替えて自分を閉じた後に呼ぶ。
  public onSlotSwitched: (() => void) | null = null;
  // 復元する手動セーブが選ばれ、自分を閉じた後に呼ぶ。
  public onLoadSnapshot: ((snapshotId: string) => void) | null = null;

  public get visible(): boolean { return this._visible; }

  // モーダルの DOM 骨格を組み、非表示で親要素へ差し込む。
  public constructor(
    root: HTMLElement,
    private readonly slots: SaveSlots,
    private readonly service: SnapshotService,
    private readonly gameSource: CurrentGameSource,
    private readonly overlayManager: OverlayManager,
  ) {
    injectCommonUiStyle();
    injectOnce('save-browser', STYLE);
    this.el = document.createElement('div');
    this.el.id = 'save-browser';
    this.el.style.display = 'none';
    root.appendChild(this.el);
  }

  // パネルを開く。開いている間はゲームを止める。
  public open(): void {
    // 表示対象を既定値(アクティブスロット・現在のステージ)へ戻す。
    this.viewedSlotId = this.slots.activeSlotId;
    this.viewedStageId = this.gameSource.current?.stageId ?? null;
    this.statusLine = '';
    this.statusIsError = false;
    this.rebuild();
    this.el.style.display = 'flex';
    this._visible = true;
    this.overlayManager.open('save-browser', this, {
      kind: 'modal', closeOnEscape: true, closeOnOutsideClick: false, gatesInput: true,
      pausesGame: true, exclusiveGroup: 'system-modal',
    });
  }

  // パネルを閉じる。
  public close(): void {
    this.el.style.display = 'none';
    this._visible = false;
    this.overlayManager.close('save-browser');
  }

  // target がこの画面の要素の内部かどうかを返す。
  public contains(target: Node): boolean {
    return this.el.contains(target);
  }

  // ステータス行の文言とエラー表示を差し替える。次の rebuild で DOM へ反映される。
  private setStatus(text: string, isError: boolean): void {
    this.statusLine = text;
    this.statusIsError = isError;
  }

  // いま手動セーブを残せるか。遊んでいるスロットを表示していて、周回が決着前であること
  // (決着後の状態は復元しても操作不能)。
  private canSaveNow(): boolean {
    const game = this.gameSource.current;
    return game !== null && this.viewedSlotId === this.slots.activeSlotId && game.snapshot.isPlaying;
  }

  // 表示しているスロット。一覧に無ければ null。
  private viewedSlot(): SaveSlotMeta | null {
    return this.slots.slots.find((s) => s.id === this.viewedSlotId) ?? null;
  }

  // 現在のスロット一覧・手動セーブの一覧を組み直して DOM に反映する。
  private rebuild(): void {
    this.el.innerHTML = '';
    const panel = document.createElement('div');
    panel.className = 'sb-panel ui-surface-focus';

    const header = document.createElement('div');
    header.className = 'sb-header';
    const title = document.createElement('span');
    title.className = 'sb-title';
    title.textContent = 'セーブデータ';
    header.appendChild(title);
    const closeBtn = new CloseButton(() => this.close());
    header.appendChild(closeBtn.element);
    panel.appendChild(header);

    // ペイン切替タブ。見せるかどうかは幅に応じて CSS が決める。
    const mobileTabs = new TabBar<'slots' | 'snapshots'>(
      [['slots', 'セーブデータ'], ['snapshots', '手動セーブ']],
      (pane) => { this.mobilePane = pane; this.rebuild(); },
    );
    mobileTabs.element.classList.add('sb-mobile-tabs');
    mobileTabs.setSelected(this.mobilePane);
    panel.appendChild(mobileTabs.element);

    const body = document.createElement('div');
    body.className = 'sb-body';
    const slotsPane = buildSlotsPane(this.slots.slots, this.slots.activeSlotId, this.viewedSlotId, {
      onSelectSlot: (id) => { this.viewedSlotId = id; this.viewedStageId = null; this.rebuild(); },
      onPlaySlot: (id) => this.handlePlaySlot(id),
      onRenameSlot: (id) => this.handleRenameSlot(id),
      onDuplicateSlot: (id) => this.handleDuplicateSlot(id),
      onExportSlot: (id) => this.handleExportSlot(id),
      onDeleteSlot: (id) => this.handleDeleteSlot(id),
      onNewSlot: () => this.handleNewSlot(),
      onImportSlot: () => this.handleImportSlot(),
    });
    slotsPane.classList.toggle('sb-pane-mobile-active', this.mobilePane === 'slots');
    body.appendChild(slotsPane);
    const snapPane = document.createElement('div');
    snapPane.className = 'sb-pane';
    snapPane.classList.toggle('sb-pane-mobile-active', this.mobilePane === 'snapshots');
    const game = this.gameSource.current;
    snapPane.appendChild(buildSnapshotPane(
      this.viewedSlot(), this.viewedStageId, this.slots.activeSlotId, game?.stageId ?? null, this.canSaveNow(), {
        onSaveNow: () => this.handleSaveNow(),
        onSelectStage: (id) => { this.viewedStageId = id; this.rebuild(); },
        onLoadSnapshot: (id, refusal) => this.handleLoadSnapshot(id, refusal),
        onTogglePin: (id, pinned) => this.handleTogglePin(id, pinned),
        onRenameSnapshot: (id) => this.handleRenameSnapshot(id),
        onDeleteSnapshot: (id) => this.handleDeleteSnapshot(id),
        onBranch: (slotId, snapId) => this.handleBranch(slotId, snapId),
        // 周回が1つも動いていない状態でも一覧の中心天体名を出せるよう、静的な表へ落とす。
        nameOf: (id) => game?.nameOfBody(id) ?? solarSystemBodyName(id),
        isReadable: (id) => this.service.isReadable(id),
      },
    ));
    body.appendChild(snapPane);
    panel.appendChild(body);

    const status = document.createElement('div');
    status.className = 'sb-status';
    status.classList.toggle('error', this.statusIsError);
    status.textContent = this.statusLine;
    panel.appendChild(status);

    this.el.appendChild(panel);
  }

  // 新しい名前を prompt で尋ねてスロット名を書き換える。キャンセル・空文字なら何もしない。
  private handleRenameSlot(id: string): void {
    const slot = this.slots.slots.find((s) => s.id === id);
    if (!slot) return;
    const name = prompt('セーブデータの名前', slot.name);
    if (!name) return;
    this.slots.renameSlot(id, name);
    this.rebuild();
  }

  // スロット全体を複製し、成功したら複製先を表示対象にする。
  private handleDuplicateSlot(id: string): void {
    const slot = this.slots.slots.find((s) => s.id === id);
    if (!slot) return;
    const dup = this.slots.duplicateSlot(id);
    if (dup) this.viewedSlotId = dup.id;
    this.rebuild();
  }

  // スロットをファイルへ書き出し、成否をステータス行へ表示する。
  private handleExportSlot(id: string): void {
    const ok = exportSlotToFile(this.slots, id);
    this.setStatus(ok ? '書き出しました。' : '書き出しに失敗しました。', !ok);
    this.rebuild();
  }

  // confirm で確認してからスロットを削除する。表示中のスロットを削除した場合はアクティブ
  // スロットへ表示を戻す。
  private handleDeleteSlot(id: string): void {
    const slot = this.slots.slots.find((s) => s.id === id);
    if (!slot) return;
    if (!confirm(`「${slot.name}」を削除します。よろしいですか?`)) return;
    this.slots.deleteSlot(id);
    if (this.viewedSlotId === id) this.viewedSlotId = this.slots.activeSlotId;
    this.rebuild();
  }

  // スロット id をアクティブにして遊び始める。遷移を要求する前に閉じる — 開いたままだと次の周回でも
  // 入力を遮断し続ける。
  private handlePlaySlot(id: string): void {
    this.slots.setActiveSlot(id);
    this.close();
    this.onSlotSwitched?.();
  }

  // 名前を prompt で尋ねて空のスロットを作り、アクティブにして遊び始める。キャンセル・空文字なら何もしない。
  private handleNewSlot(): void {
    const name = prompt('新しいセーブデータの名前', '新しいセーブデータ');
    if (!name) return;
    const slot = this.slots.createSlot(name);
    this.slots.setActiveSlot(slot.id);
    this.close();
    this.onSlotSwitched?.();
  }

  // ファイルを選択して取り込む。成功したら取り込んだスロットを表示対象にし、失敗理由を
  // ステータス行へ表示する。
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

  // 今の状態を手動セーブとして残す。名前は prompt で尋ね、成否をステータス行へ表示する。
  // 残せない状態(canSaveNow が false)なら何もしない。
  private handleSaveNow(): void {
    const game = this.gameSource.current;
    if (game === null || !this.canSaveNow()) return;
    const name = prompt('セーブの名前', '');
    const snap = this.service.addManualSave(
      game.snapshot.runSummary(), game.snapshot.serialize(), name || null,
    );
    this.setStatus(snap ? 'セーブしました。' : 'セーブに失敗しました。', !snap);
    this.rebuild();
  }

  // 手動セーブ snapId の復元を求める。読み込めない理由 refusal があれば、それをステータス行へ出して
  // 止まる。遷移を要求する前に閉じる — 開いたままだと次の周回でも入力を遮断し続ける。
  private handleLoadSnapshot(snapId: string, refusal: string | null): void {
    if (refusal !== null) {
      this.setStatus(refusal, true);
      this.rebuild();
      return;
    }
    this.close();
    this.onLoadSnapshot?.(snapId);
  }

  // クリップの印を付け外しする。付けるときは、任意で名前を付けて区別できるようにする。
  private handleTogglePin(snapId: string, currentlyPinned: boolean): void {
    this.slots.setPinned(snapId, !currentlyPinned);
    if (!currentlyPinned) {
      const name = prompt('クリップする名前(空欄なら変更しません)', '');
      if (name) this.slots.renameSnapshot(snapId, name);
    }
    this.rebuild();
  }

  // 新しい名前を prompt で尋ねて手動セーブ名を書き換える。キャンセル・空文字なら何もしない。
  private handleRenameSnapshot(id: string): void {
    const name = prompt('セーブの名前', '');
    if (!name) return;
    this.slots.renameSnapshot(id, name);
    this.rebuild();
  }

  // confirm で確認してから手動セーブを削除する。
  private handleDeleteSnapshot(id: string): void {
    if (!confirm('この手動セーブを削除します。よろしいですか?')) return;
    this.slots.deleteSnapshot(id);
    this.rebuild();
  }

  // 指定した手動セーブの時点でスロットを複製(分岐)し、成否をステータス行へ表示する。
  // 成功したら複製先を表示対象にする。
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
}
