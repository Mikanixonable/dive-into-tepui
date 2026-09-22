// 被選択物のメニュー操作と搭載部品の展開へ外部から発行できる命令インターフェースと、それをキューへ積む実装(R3)。
import type { CommandQueue } from '../command-queue';
import type { ControlSelection } from '../control-selection';
import type { Part } from '../dynamic/dynamic-entity/parts';
import type { MenuAction } from '../hud/windows/menu-actions';
import type { PlanEditor } from '../plan/plan-editor';
import type { InspectedObject, ObjectAuthoring } from './inspected-object';

// 搭載部品の展開目標を受け付けるインターフェース。
export interface PartDeployer {
  setPartDeployment(part: Part, deployed: boolean): void;
}

// 被選択物へ操作を届ける命令。受け付けるだけで、適用は次の進行の位相。
export interface ObjectMenuCommands {
  // target 固有のメニュー操作 act を実行させる。authoring と planEditor は、その操作を
  // 選んだ時点で渡されていた編集インターフェース。
  runMenu(
    target: InspectedObject, act: MenuAction, authoring: ObjectAuthoring | null,
    planEditor: PlanEditor | null,
  ): void;
  // ship の部品 part の展開目標を deployed へ設定する。
  setPartDeployment(ship: PartDeployer, part: Part, deployed: boolean): void;
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
    setPartDeployment: (ship, part, deployed) => queue.submit(
      () => ship.setPartDeployment(part, deployed)),
    rename: (target, name) => queue.submit(() => target.rename?.(name)),
  };
}
