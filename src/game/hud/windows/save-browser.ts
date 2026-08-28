// セーブデータブラウザ: 複数のセーブデータ(スロット)とそのスナップショット履歴を
// 一覧・切替・クリップ・書き出し/取り込みするフルスクリーン UI。
// 一発モーダルで、操作のたびに DOM を組み直す(毎フレーム sync は無い)。
import type { Game } from '../../game';
import { SaveSlots } from '../../save/save-slots';
import { SnapshotService } from '../../save/snapshot-service';
import { exportSlotToFile, pickAndImportSlot } from '../../save/save-transfer';
import type { SaveSlotMeta } from '../../save/save-data';
import type { OverlayHandle, OverlayManager } from '../overlay-manager';
import { CloseButton, TabBar } from '../widgets';
import { injectOnce } from '../widgets/inject-style';
import { MQ_COMPACT } from '../breakpoints';
import { buildSlotsPane } from './save-browser-slot-pane';
import { buildSnapshotPane } from './save-browser-snapshot-pane';

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
  background: var(--bg); border: 1px solid var(--edge); border-radius: var(--radius-l);
}
#save-browser .sb-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: var(--space-5) var(--space-6); border-bottom: 1px solid var(--edge); flex: 0 0 auto;
}
#save-browser .sb-title { font-size: var(--font-l); font-weight: 700; letter-spacing: 0.12em; color: var(--text); }
#save-browser .sb-body { flex: 1 1 0; min-height: 0; display: flex; gap: 1px; background: var(--edge); }
#save-browser .sb-pane {
  flex: 1 1 0; min-width: 0; overflow-y: auto; padding: var(--space-5) var(--space-5);
  display: flex; flex-direction: column; gap: var(--space-3); background: var(--bg);
  scrollbar-width: thin;
}
#save-browser .sb-pane-title { font-size: var(--font-xs); letter-spacing: 1.5px; color: var(--text-dim); }
#save-browser .sb-empty { color: var(--text-dim); padding: var(--space-5); text-align: center; line-height: 1.7; font-size: var(--font-s); }
#save-browser .sb-status { min-height: 20px; padding: var(--space-2) var(--space-5); font-size: var(--font-xs); color: var(--text-dim); border-top: 1px solid var(--edge); }
#save-browser .sb-status.error { color: var(--color-error); }
/* compact: 左右ペインを並べず、sb-mobile-tabs で切り替えた片方だけを表示する。 */
#save-browser .sb-mobile-tabs { display: none; padding: var(--space-3) var(--space-5) 0; }
@media ${MQ_COMPACT} {
  #save-browser .sb-panel { width: 100vw; height: 100vh; height: 100dvh; border-radius: 0; }
  #save-browser .sb-mobile-tabs { display: flex; }
  #save-browser .sb-body { flex-direction: column; }
  #save-browser .sb-pane:not(.sb-pane-mobile-active) { display: none; }
}
`;

// 今どの周回の Game が動いているか。Game より長生きする側(Launcher)が満たす。
export interface CurrentGameSource {
  readonly current: Game | null;
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

  // スロット切替の実処理は呼び出し側が行う。
  public onSlotSwitched: (() => void) | null = null;
  // スナップショットのロードは Game を作り直すことで表現するため、実処理は呼び出し側が行う。
  public onLoadSnapshot: ((snapshotId: string) => void) | null = null;

  public get visible(): boolean { return this._visible; }

  // モーダルの DOM 骨格だけを組み、非表示で親要素へ差し込む。中身は open のたびに rebuild する。
  public constructor(
    root: HTMLElement,
    private readonly slots: SaveSlots,
    private readonly service: SnapshotService,
    private readonly gameSource: CurrentGameSource,
    private readonly overlayManager: OverlayManager,
  ) {
    injectOnce('save-browser', STYLE);
    this.el = document.createElement('div');
    this.el.id = 'save-browser';
    this.el.style.display = 'none';
    root.appendChild(this.el);
  }

  // パネルを開く。表示対象スロットは既定でアクティブスロット、ステージタブは既定でいま
  // プレイ中のステージ。開いている間はゲームを止める。
  public open(): void {
    // 表示対象を既定値(アクティブスロット・現在のステージ)へ戻す。
    this.viewedSlotId = this.slots.activeSlotId;
    this.viewedStageId = this.gameSource.current?.activeStage.id ?? null;
    this.statusLine = '';
    this.statusIsError = false;
    this.rebuild();
    this.el.style.display = 'flex';
    this._visible = true;
    // 開いている間は裏のゲームを止め、オーバーレイとして入力を占有する。
    this.gameSource.current?.pause();
    this.overlayManager.open('save-browser', this, {
      kind: 'modal', closeOnEscape: true, closeOnOutsideClick: false, gatesInput: true, exclusiveGroup: 'system-modal',
    });
  }

  // パネルを閉じ、裏のゲームを再開する。
  public close(): void {
    this.el.style.display = 'none';
    this._visible = false;
    this.gameSource.current?.resume();
    this.overlayManager.close('save-browser');
  }

  public contains(target: Node): boolean {
    return this.el.contains(target);
  }

  // ステータス行の文言とエラー表示を差し替える。次の rebuild で DOM へ反映される。
  private setStatus(text: string, isError: boolean): void {
    this.statusLine = text;
    this.statusIsError = isError;
  }

  // 決着後(won/lost/timeup)の状態は復元しても操作不能なので撮らせない([F5] と同条件)。
  // 動いている Game が無い(周回の切り替え中)ときも撮れない。
  private canCaptureNow(): boolean {
    const game = this.gameSource.current;
    return game !== null && this.viewedSlotId === this.slots.activeSlotId && game.activeStage.isPlaying;
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
    title.textContent = 'セーブデータ';
    header.appendChild(title);
    const closeBtn = new CloseButton(() => this.close());
    header.appendChild(closeBtn.element);
    panel.appendChild(header);

    // compact 幅だけで見えるペイン切替タブ。表示条件そのものは CSS(#save-browser .sb-mobile-tabs)
    // が持ち、ここでは常に組んで選択状態だけ渡す。
    const mobileTabs = new TabBar<'slots' | 'snapshots'>(
      [['slots', 'セーブデータ'], ['snapshots', 'スナップショット']],
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
    snapPane.className = 'sb-pane sb-pane-snapshots';
    snapPane.classList.toggle('sb-pane-mobile-active', this.mobilePane === 'snapshots');
    const game = this.gameSource.current;
    snapPane.appendChild(buildSnapshotPane(
      this.viewedSlot(), this.viewedStageId, this.slots.activeSlotId, game?.activeStage.id ?? null, this.canCaptureNow(), {
        onCaptureNow: () => this.handleCaptureNow(),
        onSelectStage: (id) => { this.viewedStageId = id; this.rebuild(); },
        onLoadSnapshot: (id, loadable) => this.handleLoadSnapshot(id, loadable),
        onTogglePin: (id, pinned) => this.handleTogglePin(id, pinned),
        onRenameSnapshot: (id) => this.handleRenameSnapshot(id),
        onDeleteSnapshot: (id) => this.handleDeleteSnapshot(id),
        onBranch: (slotId, snapId) => this.handleBranch(slotId, snapId),
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

  // スロットを丸ごと複製し、成功したら複製先を表示対象にする。
  private handleDuplicateSlot(id: string): void {
    const slot = this.slots.slots.find((s) => s.id === id);
    if (!slot) return;
    const dup = this.slots.duplicateSlot(id);
    if (dup) this.viewedSlotId = dup.id;
    this.rebuild();
  }

  // confirm でクリップ済みのみか全件かを尋ねてからファイルへ書き出し、成否をステータス行へ表示する。
  private handleExportSlot(id: string): void {
    const pinnedOnly = confirm('クリップ済みのスナップショットだけを書き出しますか?(キャンセルで全件)');
    const ok = exportSlotToFile(this.slots, id, pinnedOnly);
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

  // 遷移を要求する前に自分を閉じる — 開いたままだと次の周回でも入力を遮断し続ける。
  private handlePlaySlot(id: string): void {
    this.slots.setActiveSlot(id);
    this.close();
    this.onSlotSwitched?.();
  }

  // モードとステージはまだ決まらない(タイトル画面で選ぶ)ので、空のスロットだけを作って
  // アクティブにする。実際に何を遊んだかは開始時に SaveSlots.noteLaunch が書き込む。
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

  // 今の状態を手動スナップショットとして記録する。名前は prompt で尋ね、成否をステータス
  // 行へ表示する。捕捉できない状態(canCaptureNow が false)なら何もしない。
  private handleCaptureNow(): void {
    const game = this.gameSource.current;
    if (game === null || !this.canCaptureNow()) return;
    const name = prompt('スナップショットの名前', '');
    const snap = this.service.capture(game, 'manual', name || null, true);
    this.setStatus(snap ? 'クリップしました。' : 'クリップに失敗しました。', !snap);
    this.rebuild();
  }

  // loadable でなければ理由をヒントに出すだけ。loadable なら、遷移を要求する前に自分を
  // 閉じてから onLoadSnapshot を呼ぶ — 開いたままだと次の周回でも入力を遮断し続ける。
  private handleLoadSnapshot(snapId: string, loadable: boolean): void {
    if (!loadable) {
      this.setStatus('いま遊んでいるセーブデータ・ステージのスナップショットだけを復元できます。', true);
      this.rebuild();
      return;
    }
    this.close();
    this.onLoadSnapshot?.(snapId);
  }

  // クリップ時は名前を尋ね、解除時はそのまま外す。上限に達している場合はクリップできず、
  // 理由をステータス行へ表示する。
  private handleTogglePin(snapId: string, currentlyPinned: boolean): void {
    // 解除は確認なしでそのまま外す。
    if (currentlyPinned) {
      this.slots.setPinned(snapId, false);
      this.rebuild();
      return;
    }
    // クリップは上限に達していれば失敗し、理由をステータス行へ出す。
    const ok = this.slots.setPinned(snapId, true);
    if (!ok) {
      this.setStatus('クリップ上限です。先にどれかのクリップを外してください。', true);
      this.rebuild();
      return;
    }
    // 成功したら、任意で名前を付けて区別できるようにする。
    const name = prompt('クリップする名前(空欄なら変更しません)', '');
    if (name) this.slots.renameSnapshot(snapId, name);
    this.rebuild();
  }

  // 新しい名前を prompt で尋ねてスナップショット名を書き換える。キャンセル・空文字なら何もしない。
  private handleRenameSnapshot(id: string): void {
    const name = prompt('スナップショットの名前', '');
    if (!name) return;
    this.slots.renameSnapshot(id, name);
    this.rebuild();
  }

  // confirm で確認してからスナップショットを削除する。
  private handleDeleteSnapshot(id: string): void {
    if (!confirm('このスナップショットを削除します。よろしいですか?')) return;
    this.slots.deleteSnapshot(id);
    this.rebuild();
  }

  // 指定したスナップショット時点でスロットを複製(分岐)し、成否をステータス行へ表示する。
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

  public dispose(): void {
    this.el.remove();
  }
}
