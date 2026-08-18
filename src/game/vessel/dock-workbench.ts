import type { AnyPart } from '../game-entity/parts';
import type { PartPlacement, VesselAssembly } from './assembly';

export interface WorkbenchTarget {
  readonly id: string;
  readonly assembly: VesselAssembly;
}

export interface WorkbenchSnapshot {
  readonly targets: readonly WorkbenchTarget[];
  readonly inventory: readonly AnyPart[];
}

export interface WorkbenchValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export type WorkbenchValidator = (snapshot: WorkbenchSnapshot) => WorkbenchValidation;

// ドック内の複数対象と倉庫を、適用まで直接変更しないための純粋な編集セッション。
// 3D UI はこの状態を操作し、Vessel/BaseState への書き戻しは後段の適用サービスが行う。
export class DockWorkbenchSession {
  private readonly original: WorkbenchSnapshot;
  private targets: WorkbenchTarget[];
  private inventory: AnyPart[];
  private readonly validator: WorkbenchValidator;

  public constructor(snapshot: WorkbenchSnapshot, validator: WorkbenchValidator) {
    this.original = cloneSnapshot(snapshot);
    this.targets = cloneTargets(snapshot.targets);
    this.inventory = [...snapshot.inventory];
    this.validator = validator;
  }

  public get dirty(): boolean { return !sameSnapshot(this.original, this.snapshot()); }
  public snapshot(): WorkbenchSnapshot {
    return { targets: cloneTargets(this.targets), inventory: [...this.inventory] };
  }
  public originalSnapshot(): WorkbenchSnapshot { return cloneSnapshot(this.original); }
  public validate(): WorkbenchValidation { return this.validator(this.snapshot()); }

  public replaceTarget(id: string, assembly: VesselAssembly): void {
    const index = this.targets.findIndex((target) => target.id === id);
    if (index < 0) throw new Error(`unknown workbench target: ${id}`);
    this.targets[index] = { id, assembly };
  }

  public removePlacement(targetId: string, partId: string): AnyPart {
    const target = this.target(targetId);
    const placements = [...target.assembly.placements];
    const index = placements.findIndex((placement) => placement.part.id === partId);
    if (index < 0) throw new Error(`unknown placement: ${partId}`);
    const [removed] = placements.splice(index, 1);
    this.replaceTarget(targetId, { tree: target.assembly.tree, placements });
    this.inventory.push(removed!.part);
    return removed!.part;
  }

  public installPlacement(targetId: string, placement: PartPlacement, inventoryPartId?: string): void {
    const target = this.target(targetId);
    if (inventoryPartId !== undefined) {
      const index = this.inventory.findIndex((part) => part.id === inventoryPartId);
      if (index < 0) throw new Error(`unknown inventory part: ${inventoryPartId}`);
      if (this.inventory[index]!.id !== placement.part.id) throw new Error('placement part mismatch');
      this.inventory.splice(index, 1);
    }
    this.replaceTarget(targetId, {
      tree: target.assembly.tree,
      placements: [...target.assembly.placements, placement],
    });
  }

  public movePlacement(fromTargetId: string, toTargetId: string, partId: string, placement: PartPlacement): void {
    const source = this.target(fromTargetId);
    const sourcePlacements = source.assembly.placements.filter((candidate) => candidate.part.id !== partId);
    if (sourcePlacements.length === source.assembly.placements.length) throw new Error(`unknown placement: ${partId}`);
    const destination = this.target(toTargetId);
    this.replaceTarget(fromTargetId, { tree: source.assembly.tree, placements: sourcePlacements });
    this.replaceTarget(toTargetId, {
      tree: destination.assembly.tree,
      placements: [...destination.assembly.placements, placement],
    });
  }

  public discardChanges(): void {
    this.targets = cloneTargets(this.original.targets);
    this.inventory = [...this.original.inventory];
  }

  private target(id: string): WorkbenchTarget {
    const target = this.targets.find((candidate) => candidate.id === id);
    if (!target) throw new Error(`unknown workbench target: ${id}`);
    return target;
  }
}

function cloneTargets(targets: readonly WorkbenchTarget[]): WorkbenchTarget[] {
  return targets.map((target) => ({
    id: target.id,
    assembly: { tree: target.assembly.tree, placements: [...target.assembly.placements] },
  }));
}

function cloneSnapshot(snapshot: WorkbenchSnapshot): WorkbenchSnapshot {
  return { targets: cloneTargets(snapshot.targets), inventory: [...snapshot.inventory] };
}

function sameSnapshot(a: WorkbenchSnapshot, b: WorkbenchSnapshot): boolean {
  if (a.inventory.length !== b.inventory.length || a.targets.length !== b.targets.length) return false;
  for (let i = 0; i < a.inventory.length; i++) if (a.inventory[i]!.id !== b.inventory[i]!.id) return false;
  for (let i = 0; i < a.targets.length; i++) {
    const left = a.targets[i]!; const right = b.targets[i]!;
    if (left.id !== right.id || left.assembly.placements.length !== right.assembly.placements.length) return false;
    for (let j = 0; j < left.assembly.placements.length; j++) {
      if (left.assembly.placements[j]!.part.id !== right.assembly.placements[j]!.part.id) return false;
    }
  }
  return true;
}
