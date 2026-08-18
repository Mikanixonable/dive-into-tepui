import type { AnyPart } from '../game-entity/parts';
import type { AssemblyEditResult } from './assembly-editor';
import { validateAssembly } from './assembly-editor';
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

export interface WorkbenchTargetValidation {
  readonly targetId: string;
  readonly kind: WorkbenchTargetKind;
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export interface WorkbenchValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly targets?: readonly WorkbenchTargetValidation[];
}

export type WorkbenchValidator = (snapshot: WorkbenchSnapshot) => WorkbenchValidation;
export type WorkbenchTargetValidator = (
  target: WorkbenchTarget,
  snapshot: WorkbenchSnapshot,
) => WorkbenchValidation;

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

  public get dirty(): boolean { return !sameSnapshot(this.original, this.snapshot()); }

  public snapshot(): WorkbenchSnapshot {
    return {
      targets: cloneTargets(this.targets),
      inventory: this.inventory.map(clonePart),
    };
  }

  /** State to restore when the transaction is cancelled. */
  public originalSnapshot(): WorkbenchSnapshot { return cloneSnapshot(this.original); }

  /** State handed to the build/apply layer after all target checks pass. */
  public snapshotBeforeBuild(): WorkbenchSnapshot {
    const validation = this.validate();
    if (!validation.valid) {
      throw new Error(`作業台の構成を確定できません: ${validation.errors.join('、')}`);
    }
    return cloneSnapshot(this.snapshot());
  }

  /** Alias for callers whose domain language calls the operation a build snapshot. */
  public snapshotForBuild(): WorkbenchSnapshot { return this.snapshotBeforeBuild(); }

  public validate(): WorkbenchValidation {
    const current = this.snapshot();
    const global = this.validator(current);
    const targets = this.targets.map((target) => this.validateTargetInternal(target, current));
    const errors = [
      ...global.errors,
      ...targets.flatMap((target) => target.errors.map((error) => `${target.targetId}: ${error}`)),
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

  public targetKind(targetId: string): WorkbenchTargetKind {
    return this.target(targetId).kind;
  }

  public getTarget(targetId: string): WorkbenchTarget {
    return cloneTarget(this.target(targetId));
  }

  public targetsSnapshot(): readonly WorkbenchTarget[] {
    return cloneTargets(this.targets);
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

  public replaceTarget(targetId: string, assembly: VesselAssembly, label = 'アセンブリを置換'): void {
    this.mutate(label, () => {
      this.replaceTargetInternal(targetId, assembly);
    });
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

  /** Descriptive alias for adapters that receive an editor command result. */
  public applyEditResult(
    targetId: string,
    result: AssemblyEditResult,
    label = 'アセンブリを編集',
  ): WorkbenchValidation {
    return this.applyAssemblyEdit(targetId, result, label);
  }

  public removePlacement(targetId: string, partId: string): AnyPart {
    const target = this.target(targetId);
    const placement = target.assembly.placements.find((candidate) => candidate.part.id === partId);
    if (!placement) throw new Error(`unknown placement: ${partId}`);
    this.mutate('部品を取り外す', () => {
      this.replaceTargetInternal(targetId, {
        tree: target.assembly.tree,
        placements: target.assembly.placements.filter((candidate) => candidate.part.id !== partId),
      });
      this.inventory.push(clonePart(placement.part));
    });
    return clonePart(placement.part);
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

  /** Explicit inventory API for non-drag UI controls. */
  public addInventoryPart(part: AnyPart): void {
    if (this.inventory.some((candidate) => candidate.id === part.id)
      || this.targets.some((target) => target.assembly.placements.some((placement) => placement.part.id === part.id))) {
      throw new Error(`part is already owned by the workbench: ${part.id}`);
    }
    this.mutate('部品を倉庫へ追加', () => this.inventory.push(clonePart(part)));
  }

  public removeInventoryPart(partId: string): AnyPart {
    const index = this.inventory.findIndex((part) => part.id === partId);
    if (index < 0) throw new Error(`unknown inventory part: ${partId}`);
    let removed: AnyPart | undefined;
    this.mutate('倉庫から部品を取り出す', () => {
      removed = this.inventory.splice(index, 1)[0];
    });
    return clonePart(removed!);
  }

  public movePlacementToInventory(targetId: string, partId: string): AnyPart {
    return this.removePlacement(targetId, partId);
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

  private validateTargetInternal(target: StoredTarget, snapshot: WorkbenchSnapshot): WorkbenchTargetValidation {
    const structuralErrors = validateAssembly(target.assembly, { validateBlueprint: false })
      .filter((issue) => issue.severity === 'error')
      .map((issue) => issue.message);
    const custom = this.targetValidator?.(target, snapshot) ?? { valid: true, errors: [] };
    return {
      targetId: target.id,
      kind: target.kind,
      valid: structuralErrors.length === 0 && custom.valid,
      errors: [...structuralErrors, ...custom.errors],
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
