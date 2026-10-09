// 搭載モジュールの操作を受け付け、対象の有効性を確かめて進行の位相で適用する。
import { dockingEligibility } from '../ship/ship-docking';
import type { CommandQueue } from '../command-queue';
import type { CommandCompletion } from '../command-completion';
import type { ControlSelection } from '../control-selection';
import type { EntityRegistry } from '../dynamic/entity-registry';
import type { ShipAssembly } from '../ship/ship-assembly';
import type { ModularShip } from '../ship/modular-ship';
import type { ModuleInspectionAction } from './module-inspection';

export type ModuleCommandAction = Exclude<ModuleInspectionAction, 'startConstructionModule' | 'dockModule'>;

// モジュール命令の対象が公開する、存在確認と操作の面。
export interface ModuleCommandTarget {
  readonly assembly: Pick<ShipAssembly, 'module'>;
  readonly motion: { readonly alive: boolean };
  readonly capabilities: { selectOperatingCockpit(moduleId: string): boolean };
  setModuleDeployment(moduleId: string, deployed: boolean): void;
  toggleBoosterIgnition(moduleId: string): boolean;
  decouple(moduleId: string, registry: EntityRegistry): void;
  undock(moduleId: string, registry: EntityRegistry): void;
  repairAtDock(moduleId: string): void;
}

// 登録先と、命令対象がまだ属しているかを確認する面。
export interface ModuleCommandRoster extends EntityRegistry {
  all(): readonly object[];
}

// 接舷条件の不成立を、適用そのものの失敗から区別する。
export class DockingEligibilityError extends Error {}

export class ModuleCommands {
  public constructor(
    private readonly queue: CommandQueue,
    private readonly controlSelection: ControlSelection,
    private readonly roster: ModuleCommandRoster,
  ) {}

  // モジュール操作を受け付ける。対象は受け付けた値を使い、適用時に再検証する。
  public submit(
    ship: ModuleCommandTarget, moduleId: string, action: ModuleCommandAction,
    completion: CommandCompletion,
  ): void {
    this.queue.submitWithCompletion(() => {
      this.requireModule(ship, moduleId);
      // 例外(ARCHITECTURE R8): 分離・発進の実体構築は、表示資源の生成と登録を一体で行う。
      // 構築だけを同期へ遅らせると、分割後の枝が未登録のまま進行し、接触解決から抜け落ちる。
      switch (action) {
        case 'deployModule': ship.setModuleDeployment(moduleId, true); break;
        case 'stowModule': ship.setModuleDeployment(moduleId, false); break;
        case 'toggleBoosterModule': ship.toggleBoosterIgnition(moduleId); break;
        case 'decoupleModule': ship.decouple(moduleId, this.roster); break;
        case 'repairDockedModules': ship.repairAtDock(moduleId); break;
        case 'undockModule': ship.undock(moduleId, this.roster); break;
        case 'selectCockpitModule':
          if (!ship.capabilities.selectOperatingCockpit(moduleId)) {
            throw new Error('全損したコックピットは選択できません');
          }
          break;
      }
    }, completion);
  }

  // 二つの接舷部を、適用時の距離・姿勢・能力条件で再評価して接続する。
  public dock(
    ship: ModularShip, moduleId: string, other: ModularShip, otherModuleId: string,
    completion: CommandCompletion,
  ): void {
    this.queue.submitWithCompletion(() => {
      // 適用時点の状態で、対象の存在と接舷条件を再評価する。
      const entities = this.roster.all();
      if (!ship.motion.alive || !other.motion.alive
        || !entities.includes(ship) || !entities.includes(other)) {
        throw new DockingEligibilityError('対象船体が存在しません');
      }
      if (ship.assembly.module(moduleId) === null || other.assembly.module(otherModuleId) === null) {
        throw new DockingEligibilityError('対象モジュールが存在しません');
      }
      const eligibility = dockingEligibility(ship, moduleId, other, otherModuleId);
      if (!eligibility.eligible) {
        throw new DockingEligibilityError(eligibility.reasons[0] ?? '接舷条件を満たしていません');
      }
      ship.dock(other, moduleId, otherModuleId, this.controlSelection);
    }, completion);
  }

  // 消えた船体やモジュールへの操作を拒む。
  private requireModule(ship: ModuleCommandTarget, moduleId: string): void {
    if (!ship.motion.alive || !this.roster.all().includes(ship)) {
      throw new Error('対象船体が存在しません');
    }
    if (ship.assembly.module(moduleId) === null) throw new Error('対象モジュールが存在しません');
  }
}
