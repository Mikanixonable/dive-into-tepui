// 被選択物のメニュー操作へ外部から発行できる命令インターフェースと、それをキューへ積む実装(R3)。
import type { CommandQueue } from '../command-queue';
import type { ControlSelection } from '../control-selection';
import type { MenuAction } from '../menu-actions';
import type { InspectedObject } from './inspected-object';
import type {
  PresentationPlanEditor, PresentationStageAuthoring,
} from '../presentation-ports';

// 被選択物へ操作を届ける命令。受け付けるだけで、適用は次の進行の位相。
export interface ObjectMenuCommands {
  // target 固有のメニュー操作 act を実行させる。authoring と planEditor は、その操作を
  // 選んだ時点で渡されていた編集インターフェース。
  runMenu(
    target: InspectedObject, act: MenuAction, authoring: PresentationStageAuthoring | null,
    planEditor: PresentationPlanEditor | null,
  ): void;
  // 改名を受け付ける target の名前を name へ書き換える。
  rename(target: InspectedObject, name: string): void;
}

// 被選択物への命令を queue へ積むだけの口を組む。
export function objectMenuCommands(
  queue: CommandQueue, selection: ControlSelection,
): ObjectMenuCommands {
  return {
    runMenu: (target, act, authoring, planEditor) => queue.submit(
      () => target.runMenu?.(act, selection, authoring, planEditor)),
    rename: (target, name) => queue.submit(() => target.rename?.(name)),
  };
}
