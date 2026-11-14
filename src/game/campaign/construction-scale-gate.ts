// 建造の規模ゲート: 建造設備の格ごとに、そこで組み立てられる船体の総質量の上限を定める
// (GAME.md 11.2)。判定は建造中の枝の総質量に対して部品の配置ごとに行い、上限を超える
// 配置は理由を添えて拒否される。格と上限の正本はここが持ち、ステージが自分の拠点を
// 格へ対応づける。
import type { ShipAssembly } from '../ship/ship-assembly';

// 建造設備の格。地表基地・軌道ドック・軌道造船所の順に上限が大きい。
export type ConstructionFacilityTier = 'surface-base' | 'orbital-dock' | 'orbital-shipyard';

// 設備の格ごとの、建造できる船体の総質量の上限 [kg]。
export const CONSTRUCTION_MASS_LIMIT_KG: Readonly<Record<ConstructionFacilityTier, number>> = {
  'surface-base': 3_000,
  'orbital-dock': 15_000,
  'orbital-shipyard': 60_000,
};

// 設備の格の表示名。拒否の理由文で使う。
export const CONSTRUCTION_FACILITY_TIER_LABEL: Readonly<Record<ConstructionFacilityTier, string>> = {
  'surface-base': '地表基地',
  'orbital-dock': '軌道ドック',
  'orbital-shipyard': '軌道造船所',
};

// 建造中の枝(その設備で組み立てている船体)の総質量 [kg]。枝の根の接続 connectionId で
// assembly を割り、枝側の集計を読む。
export function constructionBranchMassKg(assembly: ShipAssembly, connectionId: string): number {
  return assembly.clone().splitAt(connectionId)[1].totalMass;
}

// 規模ゲートの判定。拠点 id → 設備の格の対応を持ち、拠点ごとに上限と拒否理由を答える。
export class ConstructionScaleGate {
  public constructor(
    private readonly tierByFacilityId: Readonly<Record<string, ConstructionFacilityTier>>,
  ) {}

  // 拠点 facilityId の設備の格。対応が無ければ null が返る。
  public tierOf(facilityId: string): ConstructionFacilityTier | null {
    return this.tierByFacilityId[facilityId] ?? null;
  }

  // 拠点 facilityId で建造できる総質量の上限 [kg]。対応が無ければ null が返る。
  public massLimitKgOf(facilityId: string): number | null {
    const tier = this.tierOf(facilityId);
    return tier === null ? null : CONSTRUCTION_MASS_LIMIT_KG[tier];
  }

  // 完成見込みの総質量 branchMassKg が拠点 facilityId の上限を超える場合の拒否理由。
  // 上限に収まる場合と、対応の無い拠点では null が返る。
  public excessReason(facilityId: string, branchMassKg: number): string | null {
    const tier = this.tierOf(facilityId);
    if (tier === null) return null;
    const limit = CONSTRUCTION_MASS_LIMIT_KG[tier];
    if (branchMassKg <= limit) return null;
    return `この設備(${CONSTRUCTION_FACILITY_TIER_LABEL[tier]})では総質量 ${limit} kg までしか建造できません`
      + `(完成見込み ${Math.ceil(branchMassKg)} kg — より大きな設備が必要です)`;
  }
}
