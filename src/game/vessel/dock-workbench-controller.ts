import type { AnyPart } from '../game-entity/parts';
import type { PartPlacement } from './assembly';
import { DockWorkbenchSession, type WorkbenchValidation } from './dock-workbench';
import type { MateFailure, MateVerdict } from './assembly-mode';

export interface SnapCandidate {
  readonly placement: PartPlacement;
  readonly verdict: MateVerdict;
  readonly targetLabel: string;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
}

export interface DragState {
  readonly part: AnyPart;
  readonly sourceTargetId: string | null;
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
    this.drag = { part, sourceTargetId, sourceInventory, candidate: null };
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

  public failureText(failure: MateFailure): string {
    const labels: Record<MateFailure, string> = {
      occupied: '接続先が使用中', 'section-fit': '断面が合わない', phase: '位相が合わない',
      length: '長さが合わない', 'work-area': '作業範囲外',
    };
    return labels[failure];
  }
}
