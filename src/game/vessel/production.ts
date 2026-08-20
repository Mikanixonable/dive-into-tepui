// 設計から実機を得る経路の、資源の側(§6 B6)。設計が要求する資源・設備・電力を集計し、
// 生産可能性の判定にかけ、通れば在庫を消費する。DOM にも THREE にも依存しない —
// 実機そのものを組み立てるのは Docking であり、この層が扱うのは物の出入りだけである。
import { partBuildCost, TANK_SHELL_FRACTION } from '../economy/build-cost';
import type { FacilityId } from '../economy/facility';
import type {
  BlueprintPart, BlueprintResourceAmount, BlueprintTank, ProducibilityBlueprint,
} from '../economy/producibility';
import { chooseTankMaterial } from '../economy/producibility';
import { PROPELLANT_RESOURCE, type PropellantId } from '../economy/propellant-compatibility';
import type { ResourceId } from '../economy/resource';
import { ResourceLedger } from '../economy/resource-ledger';
import type { AnyPart } from '../game-entity/parts';
import { isPropellantTankPart } from '../game-entity/parts';
import { assemblyOf, type VesselBlueprint } from './blueprint';
import { structuralMasses } from './mass-properties';

// 機体そのものの組み立てに要る設備。搭載要素ごとの前提は、その要素が要求する資源を作る設備の
// 側(FACILITIES)が持つので、設計が直に名指すのはこれ1つである。
export const ASSEMBLY_FACILITY: FacilityId = 'assembly-dock';

// 生産時間係数 [s/kg]。搭載要素の合計質量に掛けて生産時間を出す。既定は 0 であり、
// すべての設計が即座に完成する。
export const DEFAULT_PRODUCTION_TIME_FACTOR = 0;

// 殻の材料を推進剤が決める搭載要素。加圧ガスタンクは推進剤を積まないので含まない。
function propellantTankOf(part: AnyPart): BlueprintTank | null {
  if (!isPropellantTankPart(part)) return null;
  return { propellantId: part.propellant, shellMass: part.weight * TANK_SHELL_FRACTION };
}

// 設計を、生産可能性の判定が読む形へ写す。搭載要素は1つずつ数える — 同じ種別でも質量が違えば
// 建造費も違うため、種別でまとめることはできない。
export function productionBlueprintOf(bp: VesselBlueprint): ProducibilityBlueprint {
  const parts: BlueprintPart[] = [];
  const tanks: BlueprintTank[] = [];
  for (const placement of bp.placements) {
    const part = placement.part;
    parts.push({ partId: part.id, count: 1, buildCost: partBuildCost(part), requiresFacility: [] });
    const tank = propellantTankOf(part);
    if (tank !== null) tanks.push(tank);
  }
  const structural = structuralMasses(assemblyOf(bp));
  const structure: BlueprintResourceAmount[] = [];
  if (structural.hull > 0) structure.push({ resourceId: 'hull-panel', mass: structural.hull });
  // 分離機構は外皮と同じ板金であり、独自の資源を持たない。
  const trussMass = structural.truss + structural.decoupler;
  if (trussMass > 0) structure.push({ resourceId: 'truss-member', mass: trussMass });
  return { parts, tanks, structure, requiresFacility: [ASSEMBLY_FACILITY] };
}

// 搭載要素を1つだけ作る。機体まるごとと同じ判定を通すため、その要素だけを積んだ設計として組む。
export function partProductionBlueprintOf(part: AnyPart): ProducibilityBlueprint {
  const tank = propellantTankOf(part);
  return {
    parts: [{ partId: part.id, count: 1, buildCost: partBuildCost(part), requiresFacility: [] }],
    tanks: tank === null ? [] : [tank],
    structure: [],
    requiresFacility: [ASSEMBLY_FACILITY],
  };
}

// 損傷した搭載要素を直すのに要る資源。失われた耐久の割合ぶんの資材を作り直す — 殻は残って
// いるので、タンクの殻は課金しない。
export function repairBlueprintOf(part: AnyPart): ProducibilityBlueprint {
  const lost = part.maxHp > 0 ? Math.max(0, part.maxHp - part.hp) / part.maxHp : 0;
  const buildCost = partBuildCost(part).map((cost) => ({ resourceId: cost.resourceId, mass: cost.mass * lost }));
  return {
    parts: [{ partId: part.id, count: 1, buildCost, requiresFacility: [] }],
    tanks: [],
    structure: [],
    requiresFacility: [ASSEMBLY_FACILITY],
  };
}

// 複数の搭載要素をまとめて直すのに要る資源。
export function repairAllBlueprintOf(parts: readonly AnyPart[]): ProducibilityBlueprint {
  return {
    parts: parts.map((part) => repairBlueprintOf(part).parts[0]!),
    tanks: [], structure: [], requiresFacility: [ASSEMBLY_FACILITY],
  };
}

// 推進剤を mass [kg] 補給するのに要る資源。積んでいる推進剤そのものを引く。
export function refuelBlueprintOf(propellant: PropellantId, mass: number): ProducibilityBlueprint {
  return {
    parts: [{
      partId: 'refuel', count: 1,
      buildCost: [{ resourceId: PROPELLANT_RESOURCE[propellant], mass }],
      requiresFacility: [],
    }],
    tanks: [], structure: [], requiresFacility: [],
  };
}

// 生産に要る時間 [s]。搭載要素の合計質量に係数を掛ける。係数 0 なら即時完成する。
export function productionTimeOf(bp: VesselBlueprint, factor: number): number {
  const mass = bp.placements.reduce((sum, placement) => sum + placement.part.weight, 0);
  return mass * factor;
}

// 設計が在庫から引く資源。判定と消費が同じ材料を選ぶよう、どちらもこれを通る。
export function productionResourceDemand(
  bp: ProducibilityBlueprint,
  ledger: ResourceLedger,
): ReadonlyMap<ResourceId, number> {
  const demand = new Map<ResourceId, number>();
  const add = (id: ResourceId, mass: number): void => {
    if (mass > 0) demand.set(id, (demand.get(id) ?? 0) + mass);
  };
  for (const part of bp.parts) for (const cost of part.buildCost) add(cost.resourceId, cost.mass * part.count);
  for (const item of bp.structure) add(item.resourceId, item.mass);
  for (const tank of bp.tanks) {
    const material = chooseTankMaterial(tank, ledger);
    if (material !== null) add(material, tank.shellMass);
  }
  return demand;
}

// 在庫から生産ぶんを引く。1つでも足りなければ**何も減らさず** false を返す — 途中まで引いた
// 状態で失敗すると、失敗した生産が資源だけを食ったことになる。
export function consumeProductionResources(bp: ProducibilityBlueprint, ledger: ResourceLedger): boolean {
  const demand = productionResourceDemand(bp, ledger);
  for (const [id, mass] of demand) if (ledger.amountOf(id) < mass) return false;
  for (const [id, mass] of demand) ledger.take(id, mass);
  return true;
}
