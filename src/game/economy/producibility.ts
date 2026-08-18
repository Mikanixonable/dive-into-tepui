// 設計を生産できるかどうかの判定。在庫・設備・電力に対して足りないものを列挙する。
// 生産が要求するのは資源・設備・電力の3つだけであり、Requirement.kind はこの3つに閉じる。
import { FACILITIES, FacilityDef, FacilityId } from './facility';
import { PropellantId, TANK_MATERIALS } from './propellant-compatibility';
import { ResourceId } from './resource';
import { ResourceLedger } from './resource-ledger';

// 生産を止めている要求。needed と available はどちらも実際の値で、
// 資源なら質量[kg]、電力なら[W]、設備なら基数である。
// needed が 0 の資源は「量ではなく所持そのものを要求する」もので、
// 要る質量がこの層では決まらないもの(ヒドラジンの触媒床の白金族など)に限る。
export interface Requirement {
  readonly kind: 'resource' | 'facility' | 'power';
  readonly id: string;
  readonly needed: number;
  readonly available: number;
}

// 設計が要求する資源の量。
export interface BlueprintResourceAmount {
  readonly resourceId: ResourceId;
  readonly mass: number; // kg
}

// 積む搭載要素1種。buildCost は1つあたりに要る資源で、count 倍して積み上げる。
export interface BlueprintPart {
  readonly partId: string;
  readonly count: number;
  readonly buildCost: readonly BlueprintResourceAmount[];
  readonly requiresFacility: readonly FacilityId[];
}

// 積むタンク1基。propellantId が材料適合性(§17-2)を、shellMass がタンク殻の質量を決める。
export interface BlueprintTank {
  readonly propellantId: PropellantId;
  readonly shellMass: number; // kg
}

// この関数が設計に対して要求する形。
export interface ProducibilityBlueprint {
  readonly parts: readonly BlueprintPart[];
  readonly tanks: readonly BlueprintTank[];
  // 外皮パネル・トラス部材などの構造材と、その質量。
  readonly structure: readonly BlueprintResourceAmount[];
  // 機体そのものの組み立てに要る設備。搭載要素ごとの前提は BlueprintPart が持つ。
  readonly requiresFacility: readonly FacilityId[];
}

// 資源の要求を id ごとに1件へまとめるための積み上げ。
class ResourceDemand {
  private readonly massById = new Map<ResourceId, number>();

  public add(id: ResourceId, mass: number): void {
    this.massById.set(id, (this.massById.get(id) ?? 0) + mass);
  }

  public entries(): readonly (readonly [ResourceId, number])[] {
    return [...this.massById.entries()];
  }
}

// anyOf の枠が在庫で満たされているか。1つでも持っていれば足りる。
function anyOfHeld(candidates: readonly ResourceId[], ledger: ResourceLedger): boolean {
  return candidates.some((id) => ledger.amountOf(id) > 0);
}

// 設備を建てて動かすのに要る資源を積む。anyOf の枠は、選択肢が全滅したときにだけ
// 先頭の id を代表として要求する — 表がその枠の第一候補として先に挙げているものであり、
// 代表を1つに決めておかないと同じ不足が選択肢の数だけ列挙されてしまう。
function addFacilityResources(def: FacilityDef, ledger: ResourceLedger, demand: ResourceDemand): void {
  for (const cost of def.buildCost) demand.add(cost.resourceId, cost.mass);
  for (const input of def.inputs) {
    if (anyOfHeld(input.anyOf, ledger)) continue;
    const representative = input.anyOf[0];
    if (representative !== undefined) demand.add(representative, 0);
  }
}

// 設計を生産できるかどうかを判定し、足りないものを列挙する。空配列なら生産できる。
// ledger は読むだけで、判定は在庫を一切消費しない。
export function producibility(
  bp: ProducibilityBlueprint,
  ledger: ResourceLedger,
  facilities: readonly FacilityId[],
  powerAvailable: number,
): readonly Requirement[] {
  const owned = new Set(facilities);
  const demand = new ResourceDemand();
  const missingFacilities: FacilityId[] = [];
  const required = new Set<FacilityId>();
  // 建造の間に同時に動かす設備の消費電力。所持の有無に依らず、要る設備すべてを数える。
  let powerNeeded = 0;

  // 要求された設備1基を数える。同じ設備を複数の搭載要素が要求しても、実物は1基なので
  // 消費電力も資源も1回だけ数える。
  const requireFacility = (id: FacilityId): void => {
    const def: FacilityDef | undefined = FACILITIES[id];
    if (def === undefined) return;
    if (required.has(id)) return;
    required.add(id);
    powerNeeded += def.powerDraw;
    if (owned.has(id)) return;
    missingFacilities.push(id);
    addFacilityResources(def, ledger, demand);
  };

  for (const id of bp.requiresFacility) requireFacility(id);

  for (const part of bp.parts) {
    for (const cost of part.buildCost) demand.add(cost.resourceId, cost.mass * part.count);
    for (const id of part.requiresFacility) requireFacility(id);
  }

  for (const item of bp.structure) demand.add(item.resourceId, item.mass);

  for (const tank of bp.tanks) {
    const compat = TANK_MATERIALS[tank.propellantId];
    if (compat === undefined) continue;
    // 適合する材料のどれか1つで殻を作れれば足りる。全滅したときだけ先頭を代表に立てる。
    const material = compat.allowedMaterials.find((id) => ledger.amountOf(id) >= tank.shellMass);
    const charged = material ?? compat.allowedMaterials[0];
    if (charged !== undefined) demand.add(charged, tank.shellMass);
    for (const id of compat.requiredResources) {
      if (ledger.amountOf(id) > 0) continue;
      demand.add(id, 0);
    }
  }

  const out: Requirement[] = [];
  for (const [id, needed] of demand.entries()) {
    const available = ledger.amountOf(id);
    if (available >= needed && available > 0) continue;
    if (needed === 0 && available > 0) continue;
    out.push({ kind: 'resource', id, needed, available });
  }
  for (const id of missingFacilities) out.push({ kind: 'facility', id, needed: 1, available: 0 });
  if (powerNeeded > powerAvailable) {
    out.push({ kind: 'power', id: 'power', needed: powerNeeded, available: powerAvailable });
  }
  return out;
}
