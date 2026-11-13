// 建造パネルへ渡す表示モデルの組み立て。建造セッションの読み取り面から集めた値だけで
// ShipConstructionPanelModel を組む純粋な関数を持つ。
import {
  constructionModuleLabel, constructionTargetId, placementFor, type ConstructionTargetInfo,
} from './ship-construction-rules';
import { deltaVBudget, effectiveExhaustVelocity } from '../../physics/rocket';
import { SHIP_MODULE_CATALOG } from './ship-module-catalog';
import type { ShipAssembly } from './ship-assembly';
import type { ShipAssemblyTotals } from './ship-assembly-types';
import type { ModuleOrientation } from './ship-assembly-transform';
import type { ShipBlueprint } from './ship-blueprint';
import type { ConstructionTrial } from './ship-construction-preview';
import type {
  ConstructionCapabilities, ConstructionHeld, ConstructionHistoryView, ConstructionSymmetry,
  ShipConstructionPanelModel,
} from './ship-construction-types';

// 表示モデルの材料。建造セッションの読み取り面から呼び出し側が集める値。
export interface ShipConstructionPanelSource {
  readonly shipName: string;
  readonly assembly: ShipAssembly;
  readonly anchorId: string;
  // 手に持っているものとその表示名。何も持っていなければ null。
  readonly held: { readonly item: ConstructionHeld; readonly name: string } | null;
  // 手持ちが設計図の写しのとき、その設計図の id。
  readonly heldBlueprintId: string | null;
  // 選択中のモジュールと、撤去・付け替え・回転を受け付けるか。選んでいなければ null。
  readonly selection: { readonly moduleId: string; readonly editable: boolean } | null;
  readonly orientation: ModuleOrientation;
  readonly symmetry: ConstructionSymmetry;
  // 各取り付け先へ置けるかの判定が読む手持ちと、その向き・対称数。実際の手持ち、
  // または選択中モジュールの仮の手持ち。どちらも無ければ null。
  readonly effective: {
    readonly held: ConstructionHeld;
    readonly orientation: ModuleOrientation;
    readonly symmetry: ConstructionSymmetry;
  } | null;
  readonly pointedTargetId: string | null;
  // 指している取り付け先へ手持ちを置いた試し置き。無ければ null。
  readonly trial: ConstructionTrial | null;
  readonly targets: readonly ConstructionTargetInfo[];
  readonly history: ConstructionHistoryView;
  readonly blueprints: readonly ShipBlueprint[];
  // 設計図を新たに記録できるか。
  readonly canRecordBlueprints: boolean;
}

// 集計から主推進の満載性能を求める。推力か燃料消費率が無ければ、どちらも null。
// Δv は満載質量と満載の主燃料へ同じロケット式を当てた値で、航法の計画が出す Δv と一致する。
function constructionPropulsion(totals: ShipAssemblyTotals): {
  readonly deltaV: number | null;
  readonly acceleration: number | null;
} {
  const consumption = totals.mainFuelConsumptionRate * totals.mainFuelMassPerUnit; // kg/s
  if (!(totals.thrust > 0) || !(consumption > 0)) {
    return { deltaV: null, acceleration: null };
  }
  return {
    deltaV: deltaVBudget(
      effectiveExhaustVelocity(totals.thrust, consumption), totals.fullMass, totals.maxMainFuelMass,
    ),
    acceleration: totals.thrust / totals.fullMass,
  };
}

// 集めた値から建造パネルの表示モデルを組む。
export function shipConstructionPanelModel(
  source: ShipConstructionPanelSource,
): ShipConstructionPanelModel {
  const { assembly, trial } = source;
  const totals = assembly.totals();
  const capabilitiesOf = (t: ShipAssemblyTotals): ConstructionCapabilities => ({
    thrust: t.thrust, mainFuel: t.mainFuel, rcsFuel: t.rcsFuel,
    power: t.power, radiation: t.radiation, ...constructionPropulsion(t),
  });
  const capabilities = capabilitiesOf(totals);
  const preview = trial !== null && trial.valid && trial.totals !== null ? {
    mass: trial.totals.mass, maxHp: trial.totals.maxHp,
    capabilities: capabilitiesOf(trial.totals),
  } : null;
  const pointedTarget = source.pointedTargetId === null ? null
    : source.targets.find(info => constructionTargetId(info.target) === source.pointedTargetId) ?? null;
  return {
    visible: true, shipName: source.shipName,
    held: source.held === null ? null : {
      name: source.held.name,
      catalogId: source.held.item.kind === 'catalog' ? source.held.item.definitionId : null,
      blueprintId: source.heldBlueprintId,
      orientation: source.orientation, symmetry: source.symmetry,
    },
    selection: source.selection === null ? null : {
      name: constructionModuleLabel(assembly, source.selection.moduleId),
      canEdit: source.selection.editable,
      orientation: source.effective?.orientation ?? source.orientation,
    },
    moduleCount: assembly.size, totalMass: totals.mass,
    hp: totals.hp, maxHp: totals.maxHp, capabilities, preview,
    role: assembly.role,
    placeBlockReason: source.held === null && source.selection === null ? null
      : pointedTarget === null ? '取り付け先を指してください'
      : trial !== null && !trial.valid ? trial.reason ?? 'ここには置けません'
      : null,
    pointedTargetId: source.pointedTargetId,
    targets: source.targets.map(info => {
      // 色は規則だけで決める — 重なりは指している取り付け先の試し置きだけが見る。
      const placement = source.effective === null ? null : placementFor(
        assembly, source.anchorId, source.effective.held, info.target,
        source.effective.orientation, source.effective.symmetry,
      );
      return {
        id: constructionTargetId(info.target), label: info.label,
        valid: placement?.valid ?? true, reason: placement?.reason ?? null,
      };
    }),
    history: source.history,
    blueprints: source.blueprints.map(entry => {
      // 先端部の根元は、どの接続の子でもないモジュール(piece は根を1つ持つ木)。
      const childIds = new Set(entry.piece.connections.map(edge => edge.childId));
      const root = entry.piece.modules.find(module => !childIds.has(module.id));
      return {
        id: entry.id, name: entry.name,
        modelId: root === undefined
          ? null : SHIP_MODULE_CATALOG.get(root.definitionId)?.modelId ?? null,
        moduleCount: entry.piece.modules.length,
        mass: entry.piece.modules.reduce(
          (sum, module) => sum + (SHIP_MODULE_CATALOG.get(module.definitionId)?.dryMass ?? 0), 0,
        ),
        held: source.heldBlueprintId === entry.id,
      };
    }),
    blueprintRecordReason: source.canRecordBlueprints
      ? null : '記録先のセーブデータが無いため、設計図を保存できません',
    canPlace: (source.held !== null || source.selection !== null)
      && pointedTarget !== null && (trial?.valid ?? false),
    canRemove: source.selection !== null && source.selection.editable,
  };
}
