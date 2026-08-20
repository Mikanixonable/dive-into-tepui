// 組立UI: 作業台セッションが持つ倉庫の部品を対象ごとにボタンで並べ、クリックで
// AssemblyDragController のドラッグを開始させ、3D で拾ったノード・エッジの選択を1行で示す
// 常設 HUD ウィンドウ。ドラッグ・選択の追跡・スナップ判定はこのクラスの外
// (assembly-drag-controller.ts / docking.ts)の責務で、ここはそれを表示へ映すところまでを持つ。
// 選択したノード・エッジの削除と、選択したノードの既存プリミティブの断面編集は、
// session/workbench を直に持っているのでここで組み立てて applyAssemblyEdit へ渡す —
// 新規船下書きの作成・建造(base の在庫・資源を扱う)だけは Docking 側の callback に委ねる。
// 1セッションにつき1インスタンスを持ち回して sync() で毎フレーム(または状態が変わる
// たびに)差分更新する — predict-panel.ts の PredictPanel と同じ、常設パネルの流儀。
// #hud の子として window レイヤへ置くため、`#hud, #hud *` の margin/padding
// リセットに勝てるよう全セレクタを `#hud` で始める。
import type { AnyPart, PartType } from '../game-entity/parts';
import type { SectionPrimitivePatch } from '../vessel/assembly-editor';
import { AssemblyDragController } from '../vessel/assembly-drag-controller';
import type { AssemblySelection } from '../docking';
import type { DockWorkbenchController } from '../vessel/dock-workbench-controller';
import type { DockWorkbenchSession, WorkbenchTarget, WorkbenchTargetKind } from '../vessel/dock-workbench';
import {
  MEMBER_DEFAULT_LENGTH, MEMBER_DEFAULT_RADIUS, MEMBER_DEFAULT_SEPARATION_IMPULSE,
  MEMBER_KIND_LABELS, quantizeMemberLength, type MemberKind, type MemberSpec,
} from '../vessel/member';
import { DIMENSION_UNIT, MIN_EDGE_LENGTH } from '../vessel/tree';
import { DraggableWindow } from './draggable-window';
import { PART_TYPE_LABELS } from './inventory-labels';
import type { OverlayManager } from './overlay-manager';
import type { PrimitiveShape, SectionPrimitive } from '../../physics/section-moments';
import { Button, SegmentedControl, TabBar, ToggleSwitch, ValueInput } from './widgets';

const STYLE = `
#hud .asm-panel-body { display: flex; flex-direction: column; gap: var(--space-3); padding: 0 var(--space-2) var(--space-3); }
#hud .asm-panel-targets { padding: 0 var(--space-3); }
#hud .asm-panel-actions { display: flex; gap: var(--space-2); padding: 0 var(--space-3); }
#hud .asm-panel-actions .w-btn { flex: 1; text-align: center; }
#hud .asm-panel-draft-actions { display: flex; gap: var(--space-2); padding: 0 var(--space-3); }
#hud .asm-panel-draft-actions .w-btn { flex: 1; text-align: center; }
#hud .asm-panel-selection-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: 0 var(--space-3); }
#hud .asm-panel-selection { color: var(--text); opacity: 0.85; font-size: var(--font-s); }
#hud .asm-panel-section-editor { display: flex; flex-direction: column; gap: var(--space-2); padding: 0 var(--space-3); }
#hud .asm-panel-primitive-label { color: var(--text); opacity: 0.7; font-size: var(--font-s); }
#hud .asm-panel-shape-fields { display: flex; flex-direction: column; gap: var(--space-1); }
#hud .asm-panel-edit-status { color: var(--danger); font-size: var(--font-s); padding: 0 var(--space-3); }
#hud .asm-panel-member { display: flex; flex-direction: column; gap: var(--space-2); padding: 0 var(--space-3) var(--space-2); border-top: 1px solid var(--edge); padding-top: var(--space-2); }
#hud .asm-panel-member-fields { display: flex; flex-direction: column; gap: var(--space-1); }
#hud .asm-panel-filter { padding: 0 var(--space-3); }
#hud .asm-panel-filter .w-input { width: 100%; box-sizing: border-box; }
#hud .asm-panel-errors { display: flex; flex-direction: column; gap: var(--space-1); padding: 0 var(--space-3); }
#hud .asm-panel-error-row { color: var(--danger); font-size: var(--font-s); }
#hud .asm-panel-issue-row { color: var(--text-muted); font-size: var(--font-s); }
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

const SHAPE_KIND_LABELS: readonly (readonly [PrimitiveShape['kind'], string])[] = [
  ['circle', '円'], ['ellipse', '楕円'], ['polygon', '多角形'], ['notched', '切欠き多角形'],
];

// 対象タブに出す表示名。
function targetLabel(target: WorkbenchTarget): string {
  return `${TARGET_KIND_LABELS[target.kind ?? 'docked-vessel']} · ${target.id}`;
}

// 検索欄と突き合わせる、部品1つぶんの検索対象文字列。
function partSearchText(part: AnyPart): string {
  return `${part.name} ${part.type} ${part.id}`.toLocaleLowerCase();
}

// 種別を切り替えたときの初期値。既存の外接半径(相当)を引き継ぎ、寸法をゼロから
// 打ち直させない。
function defaultShapeForKind(kind: PrimitiveShape['kind'], prev: PrimitiveShape): PrimitiveShape {
  const radius = shapeRadius(prev);
  switch (kind) {
    case 'circle': return { kind: 'circle', radius, branchCount: 4 };
    case 'ellipse': return { kind: 'ellipse', majorRadius: radius, minorRadius: radius * 0.6 };
    case 'polygon': return { kind: 'polygon', sides: 4, radius };
    case 'notched': return { kind: 'notched', sides: 6, radius };
  }
}

function shapeRadius(shape: PrimitiveShape): number {
  switch (shape.kind) {
    case 'circle': return shape.radius;
    case 'ellipse': return shape.majorRadius;
    case 'polygon': return shape.radius;
    case 'notched': return shape.radius;
  }
}

export class AssemblyPanel {
  private win: DraggableWindow | null = null;
  private targetTabs: TabBar<string> | null = null;
  private undoBtn: Button | null = null;
  private redoBtn: Button | null = null;
  private newDraftBtn: Button | null = null;
  private buildDraftBtn: Button | null = null;
  private removeDraftBtn: Button | null = null;
  private removeSelectionBtn: Button | null = null;
  private selectionEl: HTMLSpanElement | null = null;
  private sectionEditorEl: HTMLDivElement | null = null;
  private editStatusEl: HTMLDivElement | null = null;
  private filterInput: ValueInput | null = null;
  private errorsEl: HTMLDivElement | null = null;
  private shelfEl: HTMLDivElement | null = null;
  private readonly partButtons = new Map<string, { readonly btn: Button; readonly part: AnyPart }>();

  private memberImpulseRow: HTMLElement | null = null;
  private memberGrabBtn: Button | null = null;
  // 部材棚の入力欄そのものの現在値。session/選択から導く他の欄と違い、これは棚の操作でしか
  // 動かないプレイヤーの入力なので、confirm/選択の切り替わりをまたいで保持する。
  private memberKind: MemberKind = 'hull';
  private memberLength = MEMBER_DEFAULT_LENGTH;
  private memberRadius = MEMBER_DEFAULT_RADIUS;
  private memberSeparationImpulse = MEMBER_DEFAULT_SEPARATION_IMPULSE;

  private currentTargetId: string | null = null;
  private filterQuery = '';
  private lastTargetsKey = '';
  private lastInventoryKey = '';
  private lastErrorsKey = '';
  private lastSelectionKey = '';
  private lastBuildStatusKey = '';
  private lastSectionEditorKey = '';
  // 断面編集面がノード上のどのプリミティブを編集対象にしているか。ノードやプリミティブの
  // 顔ぶれが変わって候補から外れたら、rebuildSectionEditor が先頭へ落とし直す。
  private selectedPrimitiveId: string | null = null;
  // 3D クリックの結果を持ち回らない代わりに、直近の sync() が受け取った session/selection を
  // 保持する — Button の onClick は sync() の外(次のクリックが起きたそのフレーム)で走るので、
  // 編集を組み立てるにはここで持っておく必要がある。
  private lastSession: DockWorkbenchSession | null = null;
  private currentSelection: AssemblySelection = null;

  // セッションが編集対象を切り替えたことを通知する。呼び出し側はこれを見て
  // (ドッキングビュー側の3Dプレビュー等)対象の表示を追従させる。
  public onTargetSelect: ((targetId: string) => void) | null = null;
  public onUndo: (() => void) | null = null;
  public onRedo: (() => void) | null = null;
  public onConfirm: (() => void) | null = null;
  public onCancel: (() => void) | null = null;
  // 新規船下書きを作る。対象は基地に固定なので引数は無い。
  public onCreateDraft: (() => void) | null = null;
  // 指定の下書きを実艦として建造し、基地のドックへ格納する。
  public onBuildDraft: ((targetId: string) => void) | null = null;
  // 指定の下書きを捨てる。実機には何も作られていないので確認は求めない。
  public onRemoveDraft: ((targetId: string) => void) | null = null;
  // 指定の下書きを建造したときの費用と、いま賄えるか。下書きでない対象・基地が
  // 無ければ null — buildDraftBtn を隠す判定にも使う。
  public draftBuildStatus: ((targetId: string) => { readonly costText: string; readonly affordable: boolean } | null) | null = null;

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
    this.selectedPrimitiveId = null;
    if (!this.win) {
      this.win = new DraggableWindow(this.root, clientX, clientY, { title: '組立' }, this.overlayManager, 'assembly-panel');
      this.win.onClose = () => { this.close(); this.onCancel?.(); };
      this.buildBody(this.win.body);
    }
    this.lastTargetsKey = '';
    this.lastInventoryKey = '';
    this.lastErrorsKey = '';
    this.lastSelectionKey = '';
    this.lastBuildStatusKey = '';
    this.lastSectionEditorKey = '';
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
    this.newDraftBtn = null;
    this.buildDraftBtn = null;
    this.removeDraftBtn = null;
    this.removeSelectionBtn = null;
    this.selectionEl = null;
    this.sectionEditorEl = null;
    this.editStatusEl = null;
    this.filterInput = null;
    this.errorsEl = null;
    this.shelfEl = null;
    this.partButtons.clear();
    this.currentTargetId = null;
    this.lastSession = null;
    this.currentSelection = null;
  }

  // 対象タブ・Undo/Redo・下書き操作・選択(削除)・断面編集・検索欄・確定/取消ボタン・
  // 検証エラー欄・部品棚を1回だけ組み立てる。
  private buildBody(body: HTMLDivElement): void {
    body.classList.add('asm-panel-body');

    const targetsEl = document.createElement('div');
    targetsEl.className = 'asm-panel-targets';
    this.targetTabs = new TabBar<string>([], (targetId) => {
      this.currentTargetId = targetId;
      this.targetTabs?.setSelected(targetId);
      this.lastErrorsKey = '';
      this.lastBuildStatusKey = '';
      this.selectedPrimitiveId = null;
      this.lastSectionEditorKey = '';
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

    const draftActionsEl = document.createElement('div');
    draftActionsEl.className = 'asm-panel-draft-actions';
    this.newDraftBtn = new Button('新規船下書き', () => this.onCreateDraft?.());
    this.buildDraftBtn = new Button('建造して格納', () => {
      if (this.currentTargetId !== null) this.onBuildDraft?.(this.currentTargetId);
    });
    this.removeDraftBtn = new Button('下書きを削除', () => {
      if (this.currentTargetId !== null) this.onRemoveDraft?.(this.currentTargetId);
    });
    draftActionsEl.append(this.newDraftBtn.element, this.buildDraftBtn.element, this.removeDraftBtn.element);
    body.appendChild(draftActionsEl);

    const selectionRow = document.createElement('div');
    selectionRow.className = 'asm-panel-selection-row';
    this.selectionEl = document.createElement('span');
    this.selectionEl.className = 'asm-panel-selection';
    this.removeSelectionBtn = new Button('選択を削除', () => this.removeSelection());
    this.removeSelectionBtn.setEnabled(false);
    selectionRow.append(this.selectionEl, this.removeSelectionBtn.element);
    body.appendChild(selectionRow);

    this.sectionEditorEl = document.createElement('div');
    this.sectionEditorEl.className = 'asm-panel-section-editor';
    body.appendChild(this.sectionEditorEl);

    this.editStatusEl = document.createElement('div');
    this.editStatusEl.className = 'asm-panel-edit-status';
    this.editStatusEl.hidden = true;
    body.appendChild(this.editStatusEl);

    body.appendChild(this.buildMemberShelf());

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
    this.lastSession = session;
    this.currentSelection = selection;
    const targets = session.targetsSnapshot();
    if (this.currentTargetId === null || !targets.some((t) => t.id === this.currentTargetId)) {
      this.currentTargetId = targets[0]?.id ?? null;
    }
    this.syncTargets(targets);
    this.undoBtn?.setEnabled(session.canUndo);
    this.redoBtn?.setEnabled(session.canRedo);
    this.syncDraftActions(targets);
    this.syncSelection(selection);
    this.syncSectionEditor(session, selection);
    this.syncShelf(session.inventorySnapshot());
    this.syncErrors(session);
    this.memberGrabBtn?.setEnabled(!this.dragController.dragging);
  }

  // 現在の対象が下書きのときだけ「建造して格納」を出し、費用と賄えるかをラベルへ畳む
  // (base-operations-window.ts の生産タブと同じ、費用をボタン自身の文言に乗せる形)。
  private syncDraftActions(targets: readonly WorkbenchTarget[]): void {
    if (!this.buildDraftBtn) return;
    const current = targets.find((t) => t.id === this.currentTargetId);
    const isDraft = current?.kind === 'new-vessel-draft';
    this.buildDraftBtn.element.hidden = !isDraft;
    if (this.removeDraftBtn) this.removeDraftBtn.element.hidden = !isDraft;
    if (!isDraft || this.currentTargetId === null) {
      this.lastBuildStatusKey = '';
      return;
    }
    const status = this.draftBuildStatus?.(this.currentTargetId) ?? null;
    const key = status === null ? 'none' : `${status.costText}:${status.affordable}`;
    if (key === this.lastBuildStatusKey) return;
    this.lastBuildStatusKey = key;
    this.buildDraftBtn.setLabel(status === null ? '建造して格納' : `建造して格納 · ${status.costText}`);
    this.buildDraftBtn.setEnabled(status?.affordable ?? false);
  }

  // 3D で拾ったノード・エッジの選択を1行で示す。
  private syncSelection(selection: AssemblySelection): void {
    if (!this.selectionEl) return;
    this.removeSelectionBtn?.setEnabled(selection !== null);
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

  // 編集を拒んでいる理由と、設計としての指摘を分けて出す。前者は直さなければ先へ進めないもの、
  // 後者はこのまま組めるが飛べないもので、利用者にとって別の意味を持つ。
  private syncErrors(session: DockWorkbenchSession): void {
    if (!this.errorsEl || this.currentTargetId === null) return;
    const validation = session.validateTarget(this.currentTargetId);
    const rows: readonly { readonly className: string; readonly text: string }[] = [
      ...validation.blocking.map((text) => ({ className: 'asm-panel-error-row', text })),
      ...validation.issues.map((issue) => ({
        className: issue.severity === 'error' ? 'asm-panel-error-row' : 'asm-panel-issue-row',
        text: issue.severity === 'error' ? issue.message : `注意: ${issue.message}`,
      })),
    ];
    const key = rows.map((row) => `${row.className}:${row.text}`).join('|');
    if (key === this.lastErrorsKey) return;
    this.lastErrorsKey = key;
    this.errorsEl.innerHTML = '';
    for (const row of rows) {
      const el = document.createElement('div');
      el.className = row.className;
      el.textContent = row.text;
      this.errorsEl.appendChild(el);
    }
    this.win?.reclamp();
  }

  // 選択がノードを指しているときだけ、その断面の既存プリミティブを編集する面を出す。
  // 対象・選択・断面の中身のいずれかが変わったときだけ組み直す(値そのものは打鍵ごとに
  // 追わない — ValueInput の確定でしか model は動かないので、model 側のキーが変わった
  // ときだけ差し替えれば取りこぼしは無い)。
  private syncSectionEditor(session: DockWorkbenchSession, selection: AssemblySelection): void {
    if (!this.sectionEditorEl || this.currentTargetId === null) return;
    if (selection === null || selection.kind === 'edge') {
      const key = selection === null ? 'none' : `edge:${selection.edgeId}`;
      if (key === this.lastSectionEditorKey) return;
      this.lastSectionEditorKey = key;
      this.sectionEditorEl.innerHTML = '';
      return;
    }
    const node = session.getTarget(this.currentTargetId).assembly.tree.nodes.find((n) => n.id === selection.nodeId);
    if (!node) {
      const key = `missing:${selection.nodeId}`;
      if (key === this.lastSectionEditorKey) return;
      this.lastSectionEditorKey = key;
      this.sectionEditorEl.innerHTML = '';
      return;
    }
    const key = `${selection.nodeId}:${this.selectedPrimitiveId}:${JSON.stringify(node.section.primitives)}`;
    if (key === this.lastSectionEditorKey) return;
    this.lastSectionEditorKey = key;
    this.rebuildSectionEditor(selection.nodeId, node.section.primitives);
  }

  // 断面編集面を組み直す。プリミティブが2つなら ToggleSwitch(2値専用)、3つ以上なら
  // SegmentedControl で切り替え、1つしか無ければ選択面自体を出さない。
  private rebuildSectionEditor(nodeId: string, primitives: readonly SectionPrimitive[]): void {
    if (!this.sectionEditorEl) return;
    this.sectionEditorEl.innerHTML = '';
    if (primitives.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'asm-panel-empty';
      empty.textContent = '断面にプリミティブがありません。';
      this.sectionEditorEl.appendChild(empty);
      return;
    }
    if (this.selectedPrimitiveId === null || !primitives.some((p) => p.id === this.selectedPrimitiveId)) {
      this.selectedPrimitiveId = primitives[0]!.id;
    }
    if (primitives.length > 1) {
      this.sectionEditorEl.appendChild(this.buildPrimitivePicker(primitives, (id) => {
        this.selectedPrimitiveId = id;
        this.lastSectionEditorKey = '';
      }));
    }
    const primitive = primitives.find((p) => p.id === this.selectedPrimitiveId)!;

    const label = document.createElement('div');
    label.className = 'asm-panel-primitive-label';
    label.textContent = `プリミティブ: ${primitive.id}`;
    this.sectionEditorEl.appendChild(label);

    const kindPicker = new SegmentedControl<PrimitiveShape['kind']>('種別', SHAPE_KIND_LABELS, (kind) => {
      this.applyPrimitiveEdit(nodeId, primitive.id, { shape: defaultShapeForKind(kind, primitive.shape) }, '断面の種別を変更');
    });
    kindPicker.setSelected(primitive.shape.kind);
    this.sectionEditorEl.appendChild(kindPicker.element);

    const fieldsEl = document.createElement('div');
    fieldsEl.className = 'asm-panel-shape-fields';
    this.buildShapeFields(fieldsEl, primitive.shape, (shape) => {
      this.applyPrimitiveEdit(nodeId, primitive.id, { shape }, '断面の寸法を編集');
    });
    this.sectionEditorEl.appendChild(fieldsEl);

    const phaseInput = new ValueInput({ type: 'number', step: 0.01, placeholder: '位相角 rad' }, (v) => {
      this.applyPrimitiveEdit(nodeId, primitive.id, { phaseAngle: Number(v) }, '断面の位相角を編集');
    });
    phaseInput.setValue(String(primitive.phaseAngle));
    this.sectionEditorEl.appendChild(phaseInput.element);

    this.win?.reclamp();
  }

  private buildPrimitivePicker(primitives: readonly SectionPrimitive[], onSelect: (id: string) => void): HTMLElement {
    const wrap = document.createElement('div');
    if (primitives.length === 2) {
      const [a, b] = primitives as readonly [SectionPrimitive, SectionPrimitive];
      const toggle = new ToggleSwitch(`プリミティブ切替: ${a.id} → ${b.id}`, (on) => onSelect(on ? b.id : a.id));
      toggle.setOn(this.selectedPrimitiveId === b.id);
      wrap.appendChild(toggle.element);
    } else {
      const picker = new SegmentedControl<string>('プリミティブ', primitives.map((p) => [p.id, p.id] as const), onSelect);
      picker.setSelected(this.selectedPrimitiveId);
      wrap.appendChild(picker.element);
    }
    return wrap;
  }

  // 種別ごとの寸法欄。各欄は自分と他欄の直近値を閉じ込め、確定のたびに shape 全体を組んで
  // onCommit へ渡す(PrimitiveShape は判別共用体で、フィールド単位のパッチができない)。
  private buildShapeFields(container: HTMLElement, shape: PrimitiveShape, onCommit: (shape: PrimitiveShape) => void): void {
    if (shape.kind === 'circle') {
      let radius = shape.radius;
      let branchCount = shape.branchCount;
      const radiusInput = new ValueInput({ type: 'number', min: 0.01, step: 0.05, placeholder: '半径 m' },
        (v) => { radius = Number(v); onCommit({ kind: 'circle', radius, branchCount }); });
      radiusInput.setValue(String(radius));
      const branchPicker = new SegmentedControl<2 | 3 | 4 | 5 | 6>('分岐数', [[2, '2'], [3, '3'], [4, '4'], [5, '5'], [6, '6']],
        (v) => { branchCount = v; onCommit({ kind: 'circle', radius, branchCount }); });
      branchPicker.setSelected(branchCount);
      container.append(radiusInput.element, branchPicker.element);
    } else if (shape.kind === 'ellipse') {
      let majorRadius = shape.majorRadius;
      let minorRadius = shape.minorRadius;
      const majorInput = new ValueInput({ type: 'number', min: 0.01, step: 0.05, placeholder: '長径 m' },
        (v) => { majorRadius = Number(v); onCommit({ kind: 'ellipse', majorRadius, minorRadius }); });
      majorInput.setValue(String(majorRadius));
      const minorInput = new ValueInput({ type: 'number', min: 0.01, step: 0.05, placeholder: '短径 m' },
        (v) => { minorRadius = Number(v); onCommit({ kind: 'ellipse', majorRadius, minorRadius }); });
      minorInput.setValue(String(minorRadius));
      container.append(majorInput.element, minorInput.element);
    } else if (shape.kind === 'polygon') {
      let sides = shape.sides;
      let radius = shape.radius;
      const sidesPicker = new SegmentedControl<3 | 4 | 5 | 6 | 8>('辺数', [[3, '3'], [4, '4'], [5, '5'], [6, '6'], [8, '8']],
        (v) => { sides = v; onCommit({ kind: 'polygon', sides, radius }); });
      sidesPicker.setSelected(sides);
      const radiusInput = new ValueInput({ type: 'number', min: 0.01, step: 0.05, placeholder: '外接半径 m' },
        (v) => { radius = Number(v); onCommit({ kind: 'polygon', sides, radius }); });
      radiusInput.setValue(String(radius));
      container.append(sidesPicker.element, radiusInput.element);
    } else {
      let sides = shape.sides;
      let radius = shape.radius;
      const sidesToggle = new ToggleSwitch('8角にする', (on) => { sides = on ? 8 : 6; onCommit({ kind: 'notched', sides, radius }); });
      sidesToggle.setOn(sides === 8);
      const radiusInput = new ValueInput({ type: 'number', min: 0.01, step: 0.05, placeholder: '外接半径 m' },
        (v) => { radius = Number(v); onCommit({ kind: 'notched', sides, radius }); });
      radiusInput.setValue(String(radius));
      container.append(sidesToggle.element, radiusInput.element);
    }
  }

  // 選択中ノード・エッジを削除する。参照が残っている等で拒否されたら editStatusEl へ理由を出す
  // (session.validateTarget が映すのは対象全体の構造検証で、この操作自体の成否とは別物)。
  private removeSelection(): void {
    const selection = this.currentSelection;
    if (!this.lastSession || this.currentTargetId === null || selection === null) return;
    const targetId = this.currentTargetId;
    const validation = selection.kind === 'node'
      ? this.workbench.removeNode(targetId, selection.nodeId)
      : this.workbench.removeEdge(targetId, selection.edgeId);
    this.setEditStatus(validation.valid ? null : (validation.errors[0] ?? '削除できません'));
  }

  // 選択中ノードの既存プリミティブへパッチを適用する。1回の確定が1回の applyAssemblyEdit
  // 呼び出しになり、そのまま1つの取り消し可能なコマンドになる。
  private applyPrimitiveEdit(nodeId: string, primitiveId: string, patch: SectionPrimitivePatch, label: string): void {
    if (!this.lastSession || this.currentTargetId === null) return;
    const targetId = this.currentTargetId;
    const validation = this.workbench.editSection(
      targetId, { kind: 'update-primitive', nodeId, primitiveId, patch }, label,
    );
    this.setEditStatus(validation.valid ? null : (validation.errors[0] ?? '断面を編集できません'));
  }

  private setEditStatus(message: string | null): void {
    if (!this.editStatusEl) return;
    this.editStatusEl.textContent = message ?? '';
    this.editStatusEl.hidden = message === null;
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

  // 構造材(外皮エッジ・トラス・分離機構)の棚 —— 種別・長さ・断面(半径)を選んでから掴む。
  // 部品と違い在庫に実体を持たないので、押した瞬間の入力欄の値からその場で MemberSpec を組む。
  private buildMemberShelf(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'asm-panel-member';

    const kindPicker = new SegmentedControl<MemberKind>(
      '構造材',
      (Object.keys(MEMBER_KIND_LABELS) as MemberKind[]).map((kind) => [kind, MEMBER_KIND_LABELS[kind]] as const),
      (kind) => { this.memberKind = kind; this.syncMemberImpulseVisibility(); },
    );
    kindPicker.setSelected(this.memberKind);
    wrap.appendChild(kindPicker.element);

    const fields = document.createElement('div');
    fields.className = 'asm-panel-member-fields';

    const lengthInput = new ValueInput(
      { type: 'number', min: MIN_EDGE_LENGTH, step: DIMENSION_UNIT, placeholder: `長さ m (${DIMENSION_UNIT}m刻み)` },
      (v) => { this.memberLength = quantizeMemberLength(Number(v)); lengthInput.setValue(String(this.memberLength)); },
    );
    lengthInput.setValue(String(this.memberLength));
    fields.appendChild(lengthInput.element);

    const radiusInput = new ValueInput(
      { type: 'number', min: 0.05, step: 0.05, placeholder: '断面外接半径 m' },
      (v) => { this.memberRadius = Number(v); },
    );
    radiusInput.setValue(String(this.memberRadius));
    fields.appendChild(radiusInput.element);

    this.memberImpulseRow = document.createElement('div');
    const impulseInput = new ValueInput(
      { type: 'number', min: 0, step: 10, placeholder: '分離時撃力 N·s' },
      (v) => { this.memberSeparationImpulse = Math.max(0, Number(v)); },
    );
    impulseInput.setValue(String(this.memberSeparationImpulse));
    this.memberImpulseRow.appendChild(impulseInput.element);
    fields.appendChild(this.memberImpulseRow);
    wrap.appendChild(fields);
    this.syncMemberImpulseVisibility();

    this.memberGrabBtn = new Button('部材を掴む', () => this.beginMemberDrag());
    wrap.appendChild(this.memberGrabBtn.element);

    return wrap;
  }

  // 分離時撃力の欄は decoupler を選んでいるときだけ出す。
  private syncMemberImpulseVisibility(): void {
    if (this.memberImpulseRow) this.memberImpulseRow.hidden = this.memberKind !== 'decoupler';
  }

  // 棚の入力欄の現在値から MemberSpec を組み、部材のドラッグを開始する。
  private beginMemberDrag(): void {
    const member: MemberSpec = {
      kind: this.memberKind,
      length: this.memberLength,
      radius: this.memberRadius,
      separationImpulse: this.memberSeparationImpulse,
    };
    this.dragController.beginMemberDrag(this.workbench, member);
  }
}
