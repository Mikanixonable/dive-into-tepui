// 設計から実機を得る経路の、資源の側(§6 B6)。設計が要求する資源・設備・電力を集計し、
// 生産可能性の判定にかけ、通れば在庫を消費する。DOM にも THREE にも依存しない —
// 実機そのものを組み立てるのは Docking であり、この層が扱うのは物の出入りだけである。
import { partBuildCost, TANK_SHELL_FRACTION } from '../economy/build-cost';
import type { FacilityId } from '../economy/facility';
import type {
  BlueprintPart, BlueprintResourceAmount, BlueprintTank, ProducibilityBlueprint, Requirement,
} from '../economy/producibility';
import { chooseTankMaterial, producibility } from '../economy/producibility';
import type { ResourceId } from '../economy/resource';
import { ResourceLedger } from '../economy/resource-ledger';
import type { AnyPart } from '../game-entity/parts';
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
  if (part.type !== 'oxidizer_tank' && part.type !== 'reductant_tank' && part.type !== 'rcs_tank') return null;
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

// 設計を生産できるかどうか。空配列なら生産できる。
export function productionRequirements(
  bp: VesselBlueprint,
  ledger: ResourceLedger,
  facilities: readonly FacilityId[],
  powerAvailable: number,
): readonly Requirement[] {
  return producibility(productionBlueprintOf(bp), ledger, facilities, powerAvailable);
}

// 在庫から生産ぶんを引く。1つでも足りなければ**何も減らさず** false を返す — 途中まで引いた
// 状態で失敗すると、失敗した生産が資源だけを食ったことになる。
export function consumeProductionResources(bp: ProducibilityBlueprint, ledger: ResourceLedger): boolean {
  const demand = productionResourceDemand(bp, ledger);
  for (const [id, mass] of demand) if (ledger.amountOf(id) < mass) return false;
  for (const [id, mass] of demand) ledger.take(id, mass);
  return true;
}
