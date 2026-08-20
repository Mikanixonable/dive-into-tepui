import type { AnyPart } from '../game-entity/parts';
import type { AssemblyEditResult } from './assembly-editor';
import { validateAssembly } from './assembly-editor';
import { WHOLE_VESSEL, type BlueprintIssue } from './blueprint-validation';
import type { PartPlacement, VesselAssembly } from './assembly';

/** The objects which can share one workbench transaction. */
export type WorkbenchTargetKind = 'base' | 'docked-vessel' | 'new-vessel-draft';

export interface WorkbenchTarget {
  readonly id: string;
  /** Omitted by older callers; it is normalized to `docked-vessel` on entry. */
  readonly kind?: WorkbenchTargetKind;
  readonly assembly: VesselAssembly;
}

export interface WorkbenchSnapshot {
  readonly targets: readonly WorkbenchTarget[];
  readonly inventory: readonly AnyPart[];
}

// 1つの対象について、編集を拒む理由と、設計としての指摘を分けて持つ。この2つを1つの真偽値へ
// 潰すと、飛べない設計を組むこと自体が禁じられてしまう —— 飛べないのは利用者の選択であって、
// 世界の一貫性が壊れるのとは別の問題である。
export interface TargetIssues {
  /** 適用すると実機の一貫性が壊れるもの。これだけが編集と確定を拒む。 */
  readonly blocking: readonly string[];
  /** 設計として飛べるかどうかの指摘。拒まず、表示だけする。 */
  readonly issues: readonly BlueprintIssue[];
}

export interface WorkbenchTargetValidation extends TargetIssues {
  readonly targetId: string;
  readonly kind: WorkbenchTargetKind;
  readonly valid: boolean;
}

export interface WorkbenchValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly targets?: readonly WorkbenchTargetValidation[];
}

// removePlacement の返り値。validation.valid が false のときは巻き戻し済みで、
// part はまだ対象に装着されたままである。
export interface RemovePlacementResult {
  readonly part: AnyPart;
  readonly validation: WorkbenchValidation;
}

export type WorkbenchValidator = (snapshot: WorkbenchSnapshot) => WorkbenchValidation;
export type WorkbenchTargetValidator = (
  target: WorkbenchTarget,
  snapshot: WorkbenchSnapshot,
) => TargetIssues;

export interface DockWorkbenchOptions {
  /** Adds base/draft-specific checks to the common assembly checks. */
  readonly targetValidator?: WorkbenchTargetValidator;
}

/** A recorded edit, exposed for UI history menus without exposing mutable state. */
export interface WorkbenchCommand {
  readonly label: string;
  readonly before: WorkbenchSnapshot;
  readonly after: WorkbenchSnapshot;
}

interface StoredTarget {
  readonly id: string;
  readonly kind: WorkbenchTargetKind;
  readonly assembly: VesselAssembly;
}

// ドック内の船、基地、新造船の下書きと倉庫を、適用まで直接変更しないための純粋な編集セッション。
// 3D UI はこの状態を操作し、Vessel/BaseState への書き戻しは後段の適用サービスが行う。
export class DockWorkbenchSession {
  private readonly original: WorkbenchSnapshot;
  private targets: StoredTarget[];
  private inventory: AnyPart[];
  private readonly validator: WorkbenchValidator;
  private readonly targetValidator: WorkbenchTargetValidator | undefined;
  private readonly past: WorkbenchCommand[] = [];
  private readonly future: WorkbenchCommand[] = [];

  public constructor(
    snapshot: WorkbenchSnapshot,
    validator: WorkbenchValidator,
    options: DockWorkbenchOptions = {},
  ) {
    const normalized = normalizeSnapshot(snapshot);
    this.original = cloneSnapshot(normalized);
    this.targets = cloneTargets(normalized.targets);
    this.inventory = normalized.inventory.map(clonePart);
    this.validator = validator;
    this.targetValidator = options.targetValidator;
  }

  public snapshot(): WorkbenchSnapshot {
    return {
      targets: cloneTargets(this.targets),
      inventory: this.inventory.map(clonePart),
    };
  }

  /** State handed to the build/apply layer after all target checks pass. */
  public snapshotBeforeBuild(): WorkbenchSnapshot {
    const validation = this.validate();
    if (!validation.valid) {
      throw new Error(`作業台の構成を確定できません: ${validation.errors.join('、')}`);
    }
    return this.snapshot();
  }


  public validate(): WorkbenchValidation {
    const current = this.snapshot();
    const global = this.validator(current);
    const targets = this.targets.map((target) => this.validateTargetInternal(target, current));
    const errors = [
      ...global.errors,
      ...targets.flatMap((target) => target.blocking.map((message) => `${target.targetId}: ${message}`)),
    ];
    return {
      valid: global.valid && targets.every((target) => target.valid),
      errors,
      targets,
    };
  }

  public validateTarget(targetId: string): WorkbenchTargetValidation {
    return this.validateTargetInternal(this.target(targetId), this.snapshot());
  }

  public get canUndo(): boolean { return this.past.length > 0; }
  public get canRedo(): boolean { return this.future.length > 0; }

  public get undoHistory(): readonly WorkbenchCommand[] {
    return this.past.map(cloneCommand);
  }

  public get redoHistory(): readonly WorkbenchCommand[] {
    return this.future.map(cloneCommand);
  }

  // undo()/redo() が次に取り消す/やり直す操作のラベル。undoHistory/redoHistory は履歴全体を
  // 複製して返すので、ラベル1つだけを毎フレーム読む UI(assembly-panel.ts のボタン文言)向けに
  // 複製を伴わない経路を分けて持つ。
  public get nextUndoLabel(): string | null {
    return this.past.at(-1)?.label ?? null;
  }

  public get nextRedoLabel(): string | null {
    return this.future.at(-1)?.label ?? null;
  }

  public targetKind(targetId: string): WorkbenchTargetKind {
    return this.target(targetId).kind;
  }

  // 骨格(木・断面・配置)は不変なので複製しない。呼び出し側の参照比較(鏡像を組み直すか等)が
  // 編集の有無どおりに効くのは、この参照が編集の無いフレームでは変わらないことに依る。
  public getTarget(targetId: string): WorkbenchTarget {
    return this.target(targetId);
  }

  // 配列は複製する(要素そのものは共有する) —— this.targets は編集のたびに push や添字代入で
  // その場を書き換えるので、配列を渡したままだと後の編集がこの返り値にも現れてしまう。要素は
  // 編集のたびに新しいオブジェクトへ差し替わる(参照は不変)ので、要素の複製までは要らない。
  public targetsSnapshot(): readonly WorkbenchTarget[] {
    return [...this.targets];
  }

  // 実艦へ渡す対象の複製。搭載要素は可変(hp が変化する)なので、セッション側と同じオブジェクトを
  // 実艦へ渡すと、確定を取消しても実艦側で起きた変化が残ってしまう。
  public targetSnapshotForBuild(targetId: string): WorkbenchTarget {
    return cloneTarget(this.target(targetId));
  }

  public inventorySnapshot(): readonly AnyPart[] {
    return this.inventory.map(clonePart);
  }

  public undo(): boolean {
    const command = this.past.pop();
    if (!command) return false;
    this.future.push(cloneCommand(command));
    this.restore(command.before);
    return true;
  }

  public redo(): boolean {
    const command = this.future.pop();
    if (!command) return false;
    this.past.push(cloneCommand(command));
    this.restore(command.after);
    return true;
  }

  /** Apply any accepted result from assembly-editor (node, edge, section, or placement). */
  public applyAssemblyEdit(
    targetId: string,
    result: AssemblyEditResult,
    label = 'アセンブリを編集',
  ): WorkbenchValidation {
    if (!result.accepted) {
      return {
        valid: false,
        errors: result.errors.map((error) => error.message),
        targets: [this.validateTarget(targetId)],
      };
    }

    const before = this.snapshot();
    this.replaceTargetInternal(targetId, result.assembly);
    const validation = this.validate();
    if (!validation.valid) {
      this.restore(before);
      return validation;
    }
    const after = this.snapshot();
    this.record(label, before, after);
    return validation;
  }

  // 対象から部品を外して倉庫へ戻す。applyAssemblyEdit と同じく、外した結果が全体検証
  // (基地の base_module 必須等の対象別検証を含む)に落ちれば元の状態へ巻き戻し、
  // 検証結果を呼び出し側へ返す —— 拒まれたのに部品だけ倉庫へ移ってしまう状態を作らない。
  public removePlacement(targetId: string, partId: string): RemovePlacementResult {
    const target = this.target(targetId);
    const placement = target.assembly.placements.find((candidate) => candidate.part.id === partId);
    if (!placement) throw new Error(`unknown placement: ${partId}`);
    const removedPart = clonePart(placement.part);
    const before = this.snapshot();
    this.replaceTargetInternal(targetId, {
      tree: target.assembly.tree,
      placements: target.assembly.placements.filter((candidate) => candidate.part.id !== partId),
    });
    this.inventory.push(clonePart(placement.part));
    const validation = this.validate();
    if (!validation.valid) {
      this.restore(before);
      return { part: removedPart, validation };
    }
    const after = this.snapshot();
    this.record('部品を取り外す', before, after);
    return { part: removedPart, validation };
  }

  public installPlacement(targetId: string, placement: PartPlacement, inventoryPartId?: string): void {
    const target = this.target(targetId);
    const inventoryIndex = inventoryPartId === undefined
      ? -1 : this.inventory.findIndex((part) => part.id === inventoryPartId);
    if (inventoryPartId !== undefined) {
      if (inventoryIndex < 0) throw new Error(`unknown inventory part: ${inventoryPartId}`);
      if (this.inventory[inventoryIndex]!.id !== placement.part.id) throw new Error('placement part mismatch');
    }
    if (this.targets.some((candidate) => candidate.assembly.placements.some((mounted) => mounted.part.id === placement.part.id))) {
      throw new Error(`part is already mounted: ${placement.part.id}`);
    }
    this.mutate('部品を取り付ける', () => {
      if (inventoryIndex >= 0) this.inventory.splice(inventoryIndex, 1);
      this.replaceTargetInternal(targetId, {
        tree: target.assembly.tree,
        placements: [...target.assembly.placements, clonePlacement(placement)],
      });
    });
  }

  public movePlacement(
    fromTargetId: string,
    toTargetId: string,
    partId: string,
    placement: PartPlacement,
  ): void {
    const source = this.target(fromTargetId);
    const destination = this.target(toTargetId);
    const sourcePlacement = source.assembly.placements.find((candidate) => candidate.part.id === partId);
    if (!sourcePlacement) throw new Error(`unknown placement: ${partId}`);
    if (placement.part.id !== partId) throw new Error('placement part mismatch');
    if (fromTargetId !== toTargetId && destination.assembly.placements.some((candidate) => candidate.part.id === partId)) {
      throw new Error(`part is already mounted: ${partId}`);
    }
    this.mutate('部品を別対象へ移す', () => {
      this.replaceTargetInternal(fromTargetId, {
        tree: source.assembly.tree,
        placements: source.assembly.placements.filter((candidate) => candidate.part.id !== partId),
      });
      const refreshedDestination = this.target(toTargetId);
      this.replaceTargetInternal(toTargetId, {
        tree: refreshedDestination.assembly.tree,
        placements: [...refreshedDestination.assembly.placements, clonePlacement(placement)],
      });
    });
  }

  public addTarget(target: WorkbenchTarget, label = '作業対象を追加'): WorkbenchTarget {
    const normalized = normalizeTarget(target);
    if (this.targets.some((candidate) => candidate.id === normalized.id)) {
      throw new Error(`duplicate workbench target: ${normalized.id}`);
    }
    this.mutate(label, () => this.targets.push(cloneTarget(normalized)));
    return cloneTarget(normalized);
  }

  public createNewVesselDraft(id: string, assembly: VesselAssembly): WorkbenchTarget {
    return this.addTarget({ id, kind: 'new-vessel-draft', assembly }, '新造船の下書きを作成');
  }

  public removeTarget(targetId: string): void {
    const target = this.target(targetId);
    if (target.kind !== 'new-vessel-draft') {
      throw new Error('基地または格納船は作業台セッションから削除できません');
    }
    this.mutate('新造船の下書きを削除', () => {
      this.targets = this.targets.filter((candidate) => candidate.id !== targetId);
    });
  }

  /** Cancel all edits, including newly created drafts, and clear command history. */
  public cancel(): void { this.discardChanges(); }

  public discardChanges(): void {
    this.restore(this.original);
    this.past.length = 0;
    this.future.length = 0;
  }

  // 構造として組み上がるかは対象の種別によらず拒む理由になる。設計としての出来は呼び出し側の
  // 検証器が判断し、拒む理由には数えない。
  private validateTargetInternal(target: StoredTarget, snapshot: WorkbenchSnapshot): WorkbenchTargetValidation {
    const structuralIssues = validateAssembly(target.assembly, { validateBlueprint: false })
      .filter((issue) => issue.severity === 'error');
    const structural = structuralIssues.map((issue) => issue.message);
    const custom = this.targetValidator?.(target, snapshot) ?? { blocking: [], issues: [] };
    const blocking = [...structural, ...custom.blocking.filter((message) => !structural.includes(message))];
    // 拒む理由として既に挙げたものを、指摘としてもう一度並べない。文言だけでなく部位の id も
    // 揃えて突き合わせる —— 異なる部位が同じ文言の指摘を出すことがあるため。
    const blockingKeys = new Set<string>([
      ...structuralIssues.map((issue) => issueKey(issue.targetId, issue.message)),
      ...custom.blocking.map((message) => issueKey(WHOLE_VESSEL, message)),
    ]);
    return {
      targetId: target.id,
      kind: target.kind,
      valid: blocking.length === 0,
      blocking,
      issues: custom.issues.filter((issue) => !blockingKeys.has(issueKey(issue.targetId, issue.message))),
    };
  }

  private mutate(label: string, mutation: () => void): void {
    const before = this.snapshot();
    mutation();
    const after = this.snapshot();
    if (sameSnapshot(before, after)) return;
    this.record(label, before, after);
  }

  private record(label: string, before: WorkbenchSnapshot, after: WorkbenchSnapshot): void {
    this.past.push({ label, before: cloneSnapshot(before), after: cloneSnapshot(after) });
    this.future.length = 0;
  }

  private replaceTargetInternal(targetId: string, assembly: VesselAssembly): void {
    const index = this.targets.findIndex((target) => target.id === targetId);
    if (index < 0) throw new Error(`unknown workbench target: ${targetId}`);
    const target = this.targets[index]!;
    this.targets[index] = { id: target.id, kind: target.kind, assembly: cloneAssembly(assembly) };
  }

  private restore(snapshot: WorkbenchSnapshot): void {
    this.targets = cloneTargets(snapshot.targets);
    this.inventory = snapshot.inventory.map(clonePart);
  }

  private target(id: string): StoredTarget {
    const target = this.targets.find((candidate) => candidate.id === id);
    if (!target) throw new Error(`unknown workbench target: ${id}`);
    return target;
  }
}

// 部位の id と文言をあわせた指摘の同一性キー。
function issueKey(targetId: string, message: string): string {
  return `${targetId} ${message}`;
}

function normalizeSnapshot(snapshot: WorkbenchSnapshot): WorkbenchSnapshot {
  return { targets: cloneTargets(snapshot.targets), inventory: snapshot.inventory.map(clonePart) };
}

function normalizeTarget(target: WorkbenchTarget): StoredTarget {
  return {
    id: target.id,
    kind: target.kind ?? 'docked-vessel',
    assembly: cloneAssembly(target.assembly),
  };
}

function cloneTargets(targets: readonly WorkbenchTarget[]): StoredTarget[] {
  return targets.map(normalizeTarget);
}

function cloneTarget(target: WorkbenchTarget): StoredTarget {
  return normalizeTarget(target);
}

function cloneSnapshot(snapshot: WorkbenchSnapshot): WorkbenchSnapshot {
  return { targets: cloneTargets(snapshot.targets), inventory: snapshot.inventory.map(clonePart) };
}

function cloneCommand(command: WorkbenchCommand): WorkbenchCommand {
  return {
    label: command.label,
    before: cloneSnapshot(command.before),
    after: cloneSnapshot(command.after),
  };
}

function cloneAssembly(assembly: VesselAssembly): VesselAssembly {
  return cloneValue(assembly);
}

function clonePlacement(placement: PartPlacement): PartPlacement {
  return cloneValue(placement);
}

function clonePart(part: AnyPart): AnyPart {
  return cloneValue(part);
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
  if (value === null || typeof value !== 'object') return value;
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    copy[key] = cloneValue(child);
  }
  return copy as T;
}

function sameSnapshot(a: WorkbenchSnapshot, b: WorkbenchSnapshot): boolean {
  return deepEqual(a, b);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  const bKeys = Object.keys(bRecord);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.prototype.hasOwnProperty.call(bRecord, key)
    && deepEqual(aRecord[key], bRecord[key]));
}
