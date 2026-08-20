import type { AnyPart } from '../game-entity/parts';
import type { AssemblyEditResult } from './assembly-editor';
import {
  DockWorkbenchSession,
  type WorkbenchTargetKind,
  type WorkbenchValidation,
} from './dock-workbench';
import type { PartPlacement, VesselAssembly } from './assembly';
import type { MateFailure, MateVerdict } from './assembly-mode';
import type { Vec3 } from '../../physics/vec3';

export interface SnapCandidate {
  readonly placement: PartPlacement;
  readonly verdict: MateVerdict;
  readonly targetLabel: string;
  readonly position: Vec3;
  /** Retained with the preview so a base/draft preview cannot be applied to another kind. */
  readonly targetKind?: WorkbenchTargetKind;
}

export interface DragState {
  readonly part: AnyPart;
  readonly sourceTargetId: string | null;
  readonly sourceTargetKind: WorkbenchTargetKind | null;
  readonly sourceInventory: boolean;
  readonly candidate: SnapCandidate | null;
}

/** Coordinates pointer dragging, snapping, selection, and preview validation without DOM/THREE. */
export class DockWorkbenchController {
  private selectedPartRef: string | null = null;
  private drag: DragState | null = null;

  public constructor(private readonly session: DockWorkbenchSession) {}

  public get selected(): string | null { return this.selectedPartRef; }
  public get dragging(): DragState | null { return this.drag; }
  public selectPart(partRef: string | null): void { this.selectedPartRef = partRef; }

  public beginDrag(part: AnyPart, sourceTargetId: string | null, sourceInventory: boolean): void {
    this.drag = {
      part,
      sourceTargetId,
      sourceTargetKind: sourceTargetId === null ? null : this.session.targetKind(sourceTargetId),
      sourceInventory,
      candidate: null,
    };
    this.selectedPartRef = part.id;
  }

  public updateCandidate(candidate: SnapCandidate | null): void {
    if (!this.drag) return;
    this.drag = { ...this.drag, candidate };
  }

  public drop(targetId: string): WorkbenchValidation {
    const drag = this.drag;
    if (!drag) return this.session.validate();
    const candidate = drag.candidate;
    if (!candidate || !candidate.verdict.accepted) return this.session.validate();
    const targetKind = this.session.targetKind(targetId);
    if (candidate.targetKind !== undefined && candidate.targetKind !== targetKind) {
      return {
        valid: false,
        errors: ['プレビューの対象種別が現在の作業対象と一致しません'],
        targets: [this.session.validateTarget(targetId)],
      };
    }
    if (drag.sourceTargetId && !drag.sourceInventory) {
      this.session.movePlacement(drag.sourceTargetId, targetId, drag.part.id, candidate.placement);
    } else {
      this.session.installPlacement(targetId, candidate.placement, drag.sourceInventory ? drag.part.id : undefined);
    }
    this.drag = null;
    return this.session.validate();
  }

  public remove(targetId: string, partRef: string): AnyPart {
    const removed = this.session.removePlacement(targetId, partRef);
    if (this.selectedPartRef === partRef) this.selectedPartRef = null;
    return removed;
  }

  public applyAssemblyEdit(targetId: string, result: AssemblyEditResult, label?: string): WorkbenchValidation {
    return this.session.applyAssemblyEdit(targetId, result, label);
  }

  public createNewVesselDraft(id: string, assembly: VesselAssembly): void {
    this.session.createNewVesselDraft(id, assembly);
  }

  public validateTarget(targetId: string) {
    return this.session.validateTarget(targetId);
  }

  public undo(): boolean { return this.session.undo(); }
  public redo(): boolean { return this.session.redo(); }

  public cancel(): void {
    this.session.cancel();
    this.drag = null;
    this.selectedPartRef = null;
  }

  public snapshotBeforeBuild() { return this.session.snapshotBeforeBuild(); }

  public failureText(failure: MateFailure): string {
    const labels: Record<MateFailure, string> = {
      occupied: '接続先が使用中', 'section-fit': '断面が合わない', phase: '位相が合わない',
      length: '長さが合わない', 'work-area': '作業範囲外',
    };
    return labels[failure];
  }
}
