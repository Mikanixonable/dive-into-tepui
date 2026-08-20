import type { AnyPart } from '../game-entity/parts';
import type { AssemblyEditorOptions, AssemblyEditResult, SectionEdit } from './assembly-editor';
import { editSection, removeEdge, removeNode } from './assembly-editor';
import {
  DockWorkbenchSession,
  type WorkbenchTargetKind,
  type WorkbenchValidation,
} from './dock-workbench';
import type { PartPlacement, VesselAssembly } from './assembly';
import type { Vec3 } from '../../physics/vec3';

const PARTIAL_DESIGN: AssemblyEditorOptions = { validateBlueprint: false };

// 取り付けの可否は assembly-editor が下す。ここで持つのは「通ったか」と、通らなかったときの
// 人間可読な理由(AssemblyEditError.message、日本語)だけである。
export interface MateOutcome {
  readonly accepted: boolean;
  readonly reason: string | null;
}

export interface SnapCandidate {
  readonly placement: PartPlacement;
  readonly verdict: MateOutcome;
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

  // 編集中の構成は定義上、完成した設計ではない。セッションを通る編集はすべてここを経由させ、
  // 呼び出しごとに部分設計であることを言い直さずに済むようにする。完成設計としての検査は
  // 確定の1点だけで課す。
  public removeNode(targetId: string, nodeId: string): WorkbenchValidation {
    return this.applyAssemblyEdit(targetId, removeNode(this.assemblyOf(targetId), nodeId, PARTIAL_DESIGN), 'ノードを削除');
  }

  public removeEdge(targetId: string, edgeId: string): WorkbenchValidation {
    return this.applyAssemblyEdit(targetId, removeEdge(this.assemblyOf(targetId), edgeId, PARTIAL_DESIGN), 'エッジを削除');
  }

  public editSection(targetId: string, edit: SectionEdit, label: string): WorkbenchValidation {
    return this.applyAssemblyEdit(targetId, editSection(this.assemblyOf(targetId), edit, PARTIAL_DESIGN), label);
  }

  private assemblyOf(targetId: string): VesselAssembly {
    return this.session.getTarget(targetId).assembly;
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
}
