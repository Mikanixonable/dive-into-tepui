// 作業台の対象1つを検証する。実機の一貫性が壊れる指摘(編集と確定を拒む理由)と、設計として
// 飛べるかどうかの指摘とを分けて返す。基地には基地固有の不変条件も課す。
import { validateAssembly } from './assembly-editor';
import { BASE_BLUEPRINT_LIMITS, baseInvariants, type BaseModuleContinuity } from './base-assembly-validation';
import type { VesselAssembly } from './assembly';
import type { BlueprintIssue } from './blueprint-validation';
import type { TargetIssues, WorkbenchTarget, WorkbenchTargetKind } from './dock-workbench';

// 対象1つが構成として成り立つか。編集と確定を拒む理由は、実機の一貫性が壊れるものだけに絞る。
// 設計として飛べるかどうかは指摘として返し、拒まない —— 飛べない船を組めること自体は
// 利用者の選択である。continuity には基地の現在の実機状態から導いた継続性を渡す。
export function targetValidation(
  target: WorkbenchTarget,
  dockedCount: number,
  continuity: BaseModuleContinuity | null,
): TargetIssues {
  const blocking = target.kind === 'base' ? [...baseInvariants(target.assembly, dockedCount, continuity)] : [];
  return { blocking, issues: designIssues(target.assembly, target.id, target.kind) };
}

// 構成を設計として検査する。対象の種別ごとに上限が違うので、そこだけを分ける。
function designIssues(
  assembly: VesselAssembly,
  name: string,
  kind: WorkbenchTargetKind | undefined,
): readonly BlueprintIssue[] {
  const limits = kind === 'base' ? BASE_BLUEPRINT_LIMITS : undefined;
  try {
    return validateAssembly(assembly, { blueprintId: `dock-preview-${name}`, blueprintName: name, limits });
  } catch (error) {
    return [{
      severity: 'error',
      targetId: name,
      message: `構成の検証に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
    }];
  }
}
