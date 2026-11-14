// 搭載モジュールの操作を受け付け、対象の有効性を確かめて進行の位相で適用する。
// 経済が渡された場合(ストーリーモード)は、修理・マガジン製造・推進剤補給が対象の
// 拠点備蓄を消費し、足りなければ理由つきで拒否する(GAME.md 11.4)。
import { dockingEligibility } from '../ship/ship-docking';
import {
  MAGAZINE_MATERIALS, repairMaterialsCost, type StoryEconomy,
} from '../campaign/story-economy';
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
  readonly id: string;
  readonly assembly: ShipAssembly;
  readonly motion: { readonly alive: boolean };
  readonly capabilities: { selectOperatingCockpit(moduleId: string): boolean };
  setModuleDeployment(moduleId: string, deployed: boolean): void;
  toggleBoosterIgnition(moduleId: string): boolean;
  decouple(moduleId: string, registry: EntityRegistry): void;
  undock(moduleId: string, registry: EntityRegistry): void;
  repairAtDock(moduleId: string): void;
  onPickup(mags: number): void;
}

// 登録先と、命令対象がまだ属しているかを確認する面。
export interface ModuleCommandRoster extends EntityRegistry {
  all(): readonly object[];
}

// 接舷条件の不成立を、適用そのものの失敗から区別する。
export class DockingEligibilityError extends Error {}

// 健全な主推進タンクの単位質量 [kg/unit]。タンクが無ければ null。
function mainTankKgPerUnit(assembly: ShipAssembly): number | null {
  for (const module of assembly.modules) {
    if (module.kind !== 'tank' || module.hp <= 0) continue;
    const definition = assembly.definition(module.id);
    if (definition?.abilities.fuelKind !== 'main') continue;
    return definition.abilities.fuelMassPerUnit ?? 1;
  }
  return null;
}

export class ModuleCommands {
  public constructor(
    private readonly queue: CommandQueue,
    private readonly controlSelection: ControlSelection,
    private readonly roster: ModuleCommandRoster,
    private readonly economy: StoryEconomy | null = null,
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
        case 'repairDockedModules': this.repairWithCost(ship, moduleId); break;
        case 'manufactureMagazine': this.manufactureMagazine(ship); break;
        case 'refuelFromStockpile': this.refuelFromStockpile(ship); break;
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

  // 接続船体を修理する。経済がある場合は、先に修理の条件を確かめてから素材を支払う。
  private repairWithCost(ship: ModuleCommandTarget, moduleId: string): void {
    if (this.economy === null) {
      ship.repairAtDock(moduleId);
      return;
    }
    // 支払ったあとに修理自体が失敗しないよう、修理の条件を先に確かめる。
    const dock = ship.assembly.module(moduleId);
    if (dock?.kind !== 'dock') throw new Error(`not a docking module: ${moduleId}`);
    if (dock.hp <= 0) throw new Error(`docking module is destroyed: ${moduleId}`);
    if (!ship.assembly.isDockingPortOccupied(moduleId)) {
      throw new Error(`docking module is not connected: ${moduleId}`);
    }
    const cost = repairMaterialsCost(ship.assembly);
    if (cost > 0 && !this.economy.charge(ship.id, cost, 0)) {
      const balance = this.economy.stockpileOf(ship.id).materials;
      throw new Error(`素材が不足しています(修理費 ${cost} / 備蓄 ${balance} — あと ${cost - balance})`);
    }
    ship.repairAtDock(moduleId);
  }

  // マガジンを1つ製造し、対象のベルトへ追加する。製造は接続中の建造ドックを介し、
  // その船体の拠点備蓄から素材を支払う。
  private manufactureMagazine(ship: ModuleCommandTarget): void {
    const economy = this.requireEconomy('マガジンの製造はストーリーモードの拠点でのみ行えます');
    const hasWorkingDock = ship.assembly.modules.some((module) => (
      module.kind === 'dock' && module.hp > 0 && ship.assembly.isDockingPortOccupied(module.id)
    ));
    if (!hasWorkingDock) throw new Error('建造ドックへ接続した状態で製造します');
    if (!economy.charge(ship.id, MAGAZINE_MATERIALS, 0)) {
      const balance = economy.stockpileOf(ship.id).materials;
      throw new Error(
        `素材が不足しています(製造費 ${MAGAZINE_MATERIALS} / 備蓄 ${balance} — あと ${MAGAZINE_MATERIALS - balance})`,
      );
    }
    ship.onPickup(1);
  }

  // 拠点の推進剤備蓄から、接続中の船体の主推進タンクへ補給する。備蓄の単位は kg で、
  // 換算は受け取るタンクの単位質量による。空きが無ければ何も移らない。
  private refuelFromStockpile(ship: ModuleCommandTarget): void {
    const economy = this.requireEconomy('推進剤の補給はストーリーモードの拠点でのみ行えます');
    const stock = economy.stockpileOf(ship.id).propellant;
    if (stock <= 0) throw new Error('推進剤の備蓄がありません');
    const kgPerUnit = mainTankKgPerUnit(ship.assembly);
    if (kgPerUnit === null) throw new Error('主推進タンクがありません');
    const added = ship.assembly.refuel('main', Math.floor(stock / kgPerUnit));
    if (added <= 0) throw new Error('主推進タンクに空きがありません');
    // 移した分だけを備蓄から引く。換算の端数は備蓄に残る。
    if (!economy.charge(ship.id, 0, Math.round(added * kgPerUnit))) {
      throw new Error('推進剤の備蓄が不足しています');
    }
  }

  // 経済が要る操作で、経済の無いステージでは理由つきで拒否する。
  private requireEconomy(reason: string): StoryEconomy {
    if (this.economy === null) throw new Error(reason);
    return this.economy;
  }

  // 消えた船体やモジュールへの操作を拒む。
  private requireModule(ship: ModuleCommandTarget, moduleId: string): void {
    if (!ship.motion.alive || !this.roster.all().includes(ship)) {
      throw new Error('対象船体が存在しません');
    }
    if (ship.assembly.module(moduleId) === null) throw new Error('対象モジュールが存在しません');
  }
}
