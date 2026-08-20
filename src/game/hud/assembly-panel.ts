// 組立UI: 作業台セッションが持つ倉庫の部品を対象ごとにボタンで並べ、クリックで
// AssemblyDragController のドラッグを開始させ、3D で拾ったノード・エッジの選択を1行で示す
// 常設 HUD ウィンドウ。ドラッグ・選択の追跡・スナップ判定はこのクラスの外
// (assembly-drag-controller.ts / docking.ts)の責務で、ここはそれを表示へ映すところまでを持つ。
// 1セッションにつき1インスタンスを持ち回して sync() で毎フレーム(または状態が変わる
// たびに)差分更新する — predict-panel.ts の PredictPanel と同じ、常設パネルの流儀。
// #hud の子として window レイヤへ置くため、`#hud, #hud *` の margin/padding
// リセットに勝てるよう全セレクタを `#hud` で始める。
import type { AnyPart, PartType } from '../game-entity/parts';
import { AssemblyDragController } from '../vessel/assembly-drag-controller';
import type { AssemblySelection } from '../docking';
import type { DockWorkbenchController } from '../vessel/dock-workbench-controller';
import type { DockWorkbenchSession, WorkbenchTarget, WorkbenchTargetKind } from '../vessel/dock-workbench';
import { DraggableWindow } from './draggable-window';
import { PART_TYPE_LABELS } from './inventory-labels';
import type { OverlayManager } from './overlay-manager';
import { Button, TabBar, ValueInput } from './widgets';

const STYLE = `
#hud .asm-panel-body { display: flex; flex-direction: column; gap: var(--space-3); padding: 0 var(--space-2) var(--space-3); }
#hud .asm-panel-targets { padding: 0 var(--space-3); }
#hud .asm-panel-actions { display: flex; gap: var(--space-2); padding: 0 var(--space-3); }
#hud .asm-panel-actions .w-btn { flex: 1; text-align: center; }
#hud .asm-panel-selection { padding: 0 var(--space-3); color: var(--text); opacity: 0.85; font-size: var(--font-s); }
#hud .asm-panel-filter { padding: 0 var(--space-3); }
#hud .asm-panel-filter .w-input { width: 100%; box-sizing: border-box; }
#hud .asm-panel-errors { display: flex; flex-direction: column; gap: var(--space-1); padding: 0 var(--space-3); }
#hud .asm-panel-error-row { color: var(--danger); font-size: var(--font-s); }
#hud .asm-panel-shelf { display: flex; flex-direction: column; gap: var(--space-2); padding: 0 var(--space-3); max-height: 360px; overflow-y: auto; }
#hud .asm-panel-group-title { color: var(--text); opacity: 0.7; font-size: var(--font-s); padding-top: var(--space-2); }
#hud .asm-panel-group-rows { display: flex; flex-direction: column; gap: var(--space-1); }
#hud .asm-panel-part-row.w-btn { display: block; width: 100%; box-sizing: border-box; text-align: left; }
#hud .asm-panel-empty { color: var(--text); opacity: 0.6; font-size: var(--font-s); padding: 0 var(--space-3); }
`;

let styleInjected = false;

function ensureStyle(): void {
  if (styleInjected) return;
  styleInjected = true;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
}

const TARGET_KIND_LABELS: Readonly<Record<WorkbenchTargetKind, string>> = {
  base: '基地本体',
  'docked-vessel': 'ドック中の船',
  'new-vessel-draft': '新規船下書き',
};

// 対象タブに出す表示名。
function targetLabel(target: WorkbenchTarget): string {
  return `${TARGET_KIND_LABELS[target.kind ?? 'docked-vessel']} · ${target.id}`;
}

// 検索欄と突き合わせる、部品1つぶんの検索対象文字列。
function partSearchText(part: AnyPart): string {
  return `${part.name} ${part.type} ${part.id}`.toLocaleLowerCase();
}

export class AssemblyPanel {
  private win: DraggableWindow | null = null;
  private targetTabs: TabBar<string> | null = null;
  private undoBtn: Button | null = null;
  private redoBtn: Button | null = null;
  private filterInput: ValueInput | null = null;
  private selectionEl: HTMLDivElement | null = null;
  private errorsEl: HTMLDivElement | null = null;
  private shelfEl: HTMLDivElement | null = null;
  private readonly partButtons = new Map<string, { readonly btn: Button; readonly part: AnyPart }>();

  private currentTargetId: string | null = null;
  private filterQuery = '';
  private lastTargetsKey = '';
  private lastInventoryKey = '';
  private lastErrorsKey = '';
  private lastSelectionKey = '';

  // セッションが編集対象を切り替えたことを通知する。呼び出し側はこれを見て
  // (ドッキングビュー側の3Dプレビュー等)対象の表示を追従させる。
  public onTargetSelect: ((targetId: string) => void) | null = null;
  public onUndo: (() => void) | null = null;
  public onRedo: (() => void) | null = null;
  public onConfirm: (() => void) | null = null;
  public onCancel: (() => void) | null = null;

  // workbench は AssemblyDragController.beginDrag が要る DockWorkbenchController — 読み取り専用の
  // 表示に使う DockWorkbenchSession とは別物で、open/sync の session 引数とは別に持ち回す。
  public constructor(
    private readonly root: HTMLElement,
    private readonly overlayManager: OverlayManager,
    private readonly dragController: AssemblyDragController,
    private readonly workbench: DockWorkbenchController,
  ) {}

  // clientX/clientY を左上角として、session の内容で組立ウィンドウを開く。既に開いていれば
  // 内容だけを差し替えて位置は動かさない — target はまだ target 一覧に無い呼び出し元
  // (直前に作った新規下書き等)でも編集対象として即座に選べるよう、明示的に渡させる。
  public open(session: DockWorkbenchSession, target: WorkbenchTarget, clientX: number, clientY: number): void {
    ensureStyle();
    this.currentTargetId = target.id;
    if (!this.win) {
      this.win = new DraggableWindow(this.root, clientX, clientY, { title: '組立' }, this.overlayManager, 'assembly-panel');
      this.win.onClose = () => { this.close(); this.onCancel?.(); };
      this.buildBody(this.win.body);
    }
    this.lastTargetsKey = '';
    this.lastInventoryKey = '';
    this.lastErrorsKey = '';
    this.lastSelectionKey = '';
    this.win.bringToFront();
    this.sync(session, null);
  }

  // 開いているウィンドウを閉じる。以後 sync() は何もしない。
  public close(): void {
    if (!this.win) return;
    this.win.dispose();
    this.win = null;
    this.targetTabs = null;
    this.undoBtn = null;
    this.redoBtn = null;
    this.filterInput = null;
    this.selectionEl = null;
    this.errorsEl = null;
    this.shelfEl = null;
    this.partButtons.clear();
    this.currentTargetId = null;
  }

  // 対象タブ・Undo/Redo・検索欄・確定/取消ボタン・検証エラー欄・部品棚を1回だけ組み立てる。
  private buildBody(body: HTMLDivElement): void {
    body.classList.add('asm-panel-body');

    const targetsEl = document.createElement('div');
    targetsEl.className = 'asm-panel-targets';
    this.targetTabs = new TabBar<string>([], (targetId) => {
      this.currentTargetId = targetId;
      this.targetTabs?.setSelected(targetId);
      this.lastErrorsKey = '';
      this.onTargetSelect?.(targetId);
    });
    targetsEl.appendChild(this.targetTabs.element);
    body.appendChild(targetsEl);

    const actionsEl = document.createElement('div');
    actionsEl.className = 'asm-panel-actions';
    this.undoBtn = new Button('元に戻す', () => this.onUndo?.());
    this.redoBtn = new Button('やり直す', () => this.onRedo?.());
    const confirmBtn = new Button('確定', () => this.onConfirm?.());
    const cancelBtn = new Button('取消', () => this.onCancel?.());
    actionsEl.append(this.undoBtn.element, this.redoBtn.element, confirmBtn.element, cancelBtn.element);
    body.appendChild(actionsEl);

    this.selectionEl = document.createElement('div');
    this.selectionEl.className = 'asm-panel-selection';
    body.appendChild(this.selectionEl);

    const filterEl = document.createElement('div');
    filterEl.className = 'asm-panel-filter';
    this.filterInput = new ValueInput(
      { type: 'search', placeholder: '部品を検索 (名前 / 種別 / partRef)', escapeBehavior: 'clear' },
      (text) => this.applyFilter(text),
      () => this.applyFilter(''),
    );
    filterEl.appendChild(this.filterInput.element);
    body.appendChild(filterEl);

    this.errorsEl = document.createElement('div');
    this.errorsEl.className = 'asm-panel-errors';
    body.appendChild(this.errorsEl);

    this.shelfEl = document.createElement('div');
    this.shelfEl.className = 'asm-panel-shelf';
    body.appendChild(this.shelfEl);
  }

  // 検索欄の確定値を反映し、一致しない部品ボタンだけを隠す。棚の組み直しはしない。
  private applyFilter(query: string): void {
    this.filterQuery = query.trim().toLocaleLowerCase();
    for (const entry of this.partButtons.values()) {
      entry.btn.element.hidden = this.filterQuery.length > 0 && !partSearchText(entry.part).includes(this.filterQuery);
    }
    this.win?.reclamp();
  }

  // 毎フレーム(または状態が変わったとみなせるたび)に session の内容と3D選択を読み直して
  // ウィンドウへ反映する。開いていなければ何もしない — 呼び出し側は open/close の
  // タイミングを気にせず常に呼んでよい。
  public sync(session: DockWorkbenchSession | null, selection: AssemblySelection): void {
    if (!this.win || !session) return;
    const targets = session.targetsSnapshot();
    if (this.currentTargetId === null || !targets.some((t) => t.id === this.currentTargetId)) {
      this.currentTargetId = targets[0]?.id ?? null;
    }
    this.syncTargets(targets);
    this.undoBtn?.setEnabled(session.canUndo);
    this.redoBtn?.setEnabled(session.canRedo);
    this.syncSelection(selection);
    this.syncShelf(session.inventorySnapshot());
    this.syncErrors(session);
  }

  // 3D で拾ったノード・エッジの選択を1行で示す。A4 の断面編集面はこの下に置く。
  private syncSelection(selection: AssemblySelection): void {
    if (!this.selectionEl) return;
    const key = selection === null ? '' : `${selection.kind}:${selection.kind === 'node' ? selection.nodeId : selection.edgeId}`;
    if (key === this.lastSelectionKey) return;
    this.lastSelectionKey = key;
    this.selectionEl.textContent = selection === null ? '選択: なし'
      : selection.kind === 'node' ? `選択: ノード ${selection.nodeId}`
      : `選択: エッジ ${selection.edgeId}`;
  }

  private syncTargets(targets: readonly WorkbenchTarget[]): void {
    const key = targets.map((t) => `${t.id}:${t.kind ?? 'docked-vessel'}`).join('|');
    if (key !== this.lastTargetsKey) {
      this.lastTargetsKey = key;
      this.targetTabs?.setItems(targets.map((t) => [t.id, targetLabel(t)] as const));
    }
    if (this.currentTargetId !== null) this.targetTabs?.setSelected(this.currentTargetId);
  }

  private syncErrors(session: DockWorkbenchSession): void {
    if (!this.errorsEl || this.currentTargetId === null) return;
    const errors = session.validateTarget(this.currentTargetId).errors;
    const key = errors.join('|');
    if (key === this.lastErrorsKey) return;
    this.lastErrorsKey = key;
    this.errorsEl.innerHTML = '';
    for (const error of errors) {
      const row = document.createElement('div');
      row.className = 'asm-panel-error-row';
      row.textContent = error;
      this.errorsEl.appendChild(row);
    }
    this.win?.reclamp();
  }

  // 倉庫の中身(部品 id 集合)が変わったときだけ棚を種別ごとに組み直す。値そのものが
  // 変わらない再描画(選択対象の切り替え等)ではボタンを作り直さない — 押しかけの
  // クリックを取りこぼさないため。
  private syncShelf(inventory: readonly AnyPart[]): void {
    if (!this.shelfEl) return;
    const key = inventory.map((p) => p.id).join('|');
    if (key === this.lastInventoryKey) {
      this.applyFilter(this.filterInput?.element.value ?? this.filterQuery);
      return;
    }
    this.lastInventoryKey = key;
    this.shelfEl.innerHTML = '';
    this.partButtons.clear();

    const byType = new Map<PartType, AnyPart[]>();
    for (const part of inventory) {
      const list = byType.get(part.type);
      if (list) list.push(part); else byType.set(part.type, [part]);
    }
    if (byType.size === 0) {
      const empty = document.createElement('div');
      empty.className = 'asm-panel-empty';
      empty.textContent = '倉庫に部品がありません。';
      this.shelfEl.appendChild(empty);
    }
    for (const [type, parts] of byType) {
      const group = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'asm-panel-group-title';
      title.textContent = `${PART_TYPE_LABELS[type]} (${parts.length})`;
      const rows = document.createElement('div');
      rows.className = 'asm-panel-group-rows';
      for (const part of parts) {
        const btn = new Button(`${part.name} · ${Math.round(part.weight)} kg`, () => this.beginDrag(part));
        btn.element.classList.add('asm-panel-part-row');
        this.partButtons.set(part.id, { btn, part });
        rows.appendChild(btn.element);
      }
      group.append(title, rows);
      this.shelfEl.appendChild(group);
    }
    this.applyFilter(this.filterInput?.element.value ?? this.filterQuery);
    this.win?.reclamp();
  }

  // 倉庫の部品ボタンから、現在の編集対象へ向けたドラッグを開始する。倉庫からの新規部品
  // なので sourceInventory は常に true — 装着済み部品を3Dハルから直接掴むドラッグは
  // このパネルの外(別モジュール)の経路。
  private beginDrag(part: AnyPart): void {
    if (this.currentTargetId === null) return;
    this.dragController.beginDrag(this.workbench, part, this.currentTargetId, true);
  }
}
