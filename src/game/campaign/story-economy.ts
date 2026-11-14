// ストーリーモードの経済: 拠点ごとの備蓄(素材・推進剤)の台帳と、建造・修理・製造・
// ドロップ・生産の価格と量の規則(GAME.md 11.4)。台帳はストーリーのステージが所有し、
// 支出・返金・生産の増減は stockpileChanged の出来事でキャンペーンへ同期する。回収に
// よる増加は回収そのものの出来事(materialsRecovered)が同期を持つため、ここでは積むだけ。
import type { ShipAssembly } from '../ship/ship-assembly';
import type { ShipModuleDefinition } from '../ship/ship-module-definition';
import type { RunEventSink } from '../run-events';
import { EMPTY_STOCKPILE, type BaseStockpile } from './campaign-state';

// モジュール価格の乾燥質量あたりの素材 [素材/kg]。価格はこの比例項と、大型ほど
// 非線形に高くなる二次の項の和で決まる。
export const MODULE_MATERIALS_PER_DRY_KG = 0.2;
export const MODULE_MATERIALS_QUADRATIC = 0.0005;
// 修理費は、損傷したモジュールの価格に損傷割合を掛けた合計のこの割合。
export const REPAIR_MATERIALS_RATIO = 0.3;
// マガジン1つの製造費 [素材]。
export const MAGAZINE_MATERIALS = 5;
// 敵ドロップの素材: 基礎量 + 機体質量あたりの量(上限つき)。
export const ENEMY_DROP_BASE_MATERIALS = 20;
export const ENEMY_DROP_MATERIALS_PER_KG = 0.005;
export const ENEMY_DROP_MAX_MATERIALS = 120;
// 月面基地の生産速度。能動的な回収(デブリ1つで素材 120)に明確に劣る水準に置く。
export const LUNAR_BASE_MATERIALS_PER_HOUR = 6;
export const LUNAR_BASE_PROPELLANT_PER_HOUR = 30;
// キャンペーン開始時の月面基地の初期備蓄。未完成のロケットの完成(推進器 12)に
// 足り、試行錯誤のぶんの余裕を持つ量。
export const LUNAR_BASE_INITIAL_MATERIALS = 100;
export const LUNAR_BASE_INITIAL_PROPELLANT = 200;
// 軌道造船所の建設費 [素材]。観測拠点の備蓄から払い、格上げする(GAME.md 11.2)。
// 敵ドロップ(1機で最大 120)数機ぶんを拠点へ運び込む規模に置く。
export const SHIPYARD_CONSTRUCTION_MATERIALS = 300;

// モジュール1つの建造費 [素材]。最小でも 1 かかる。
export function moduleMaterialsCost(definition: ShipModuleDefinition): number {
  const linear = definition.dryMass * MODULE_MATERIALS_PER_DRY_KG;
  const quadratic = definition.dryMass * definition.dryMass * MODULE_MATERIALS_QUADRATIC;
  return Math.max(1, Math.ceil(linear + quadratic));
}

// 船体全体の修理費 [素材]。損傷が無ければ 0。
export function repairMaterialsCost(assembly: ShipAssembly): number {
  let total = 0;
  for (const module of assembly.modules) {
    const definition = assembly.definition(module.id);
    if (definition === null || definition.maxHp <= 0) continue;
    const missing = Math.max(0, definition.maxHp - module.hp);
    if (missing > 0) total += moduleMaterialsCost(definition) * (missing / definition.maxHp);
  }
  return Math.ceil(total * REPAIR_MATERIALS_RATIO);
}

// 質量 massKg [kg] の敵を撃破したときのドロップ素材。
export function enemyDropMaterials(massKg: number): number {
  if (!Number.isFinite(massKg) || massKg <= 0) return ENEMY_DROP_BASE_MATERIALS;
  return Math.min(
    ENEMY_DROP_MAX_MATERIALS,
    ENEMY_DROP_BASE_MATERIALS + Math.ceil(massKg * ENEMY_DROP_MATERIALS_PER_KG),
  );
}

// 台帳の直列化した形。生産の端数は整数化されていない生産量の残り。
export interface SerializedStoryEconomy {
  readonly stockpiles: Readonly<Record<string, BaseStockpile>>;
  readonly productionRemainders: Readonly<Record<string, BaseStockpile>>;
  // この台帳で建造を完了した枝の乾燥質量の合計 [kg]。評価の集計の、このランぶん。
  readonly builtMassKg: number;
}

// 拠点ごとの備蓄の台帳。値は整数の素材・推進剤で持ち、生産だけが端数を抱える。
export class StoryEconomy {
  private readonly stockpiles = new Map<string, { materials: number; propellant: number }>();
  private readonly remainders = new Map<string, { materials: number; propellant: number }>();
  private builtMassTotalKg = 0;

  // 台帳の初期値から組む。省いた値は空の台帳から始める。
  public constructor(
    private readonly events: RunEventSink,
    stockpiles: Readonly<Record<string, BaseStockpile>> = {},
    productionRemainders: Readonly<Record<string, BaseStockpile>> = {},
    builtMassKg = 0,
  ) {
    for (const [baseId, stockpile] of Object.entries(stockpiles)) {
      this.stockpiles.set(baseId, { materials: stockpile.materials, propellant: stockpile.propellant });
    }
    for (const [baseId, remainder] of Object.entries(productionRemainders)) {
      this.remainders.set(baseId, { materials: remainder.materials, propellant: remainder.propellant });
    }
    this.builtMassTotalKg = builtMassKg;
  }

  // 直列化した台帳から復元する。記録が無ければ空の台帳から始める。
  public static deserialize(
    serialized: SerializedStoryEconomy | null | undefined, events: RunEventSink,
  ): StoryEconomy {
    return new StoryEconomy(
      events, serialized?.stockpiles ?? {}, serialized?.productionRemainders ?? {},
      serialized?.builtMassKg ?? 0,
    );
  }

  // 台帳を直列化した形へ畳む。
  public serialize(): SerializedStoryEconomy {
    const stockpiles: Record<string, BaseStockpile> = {};
    for (const [baseId, stockpile] of this.stockpiles) stockpiles[baseId] = { ...stockpile };
    const productionRemainders: Record<string, BaseStockpile> = {};
    for (const [baseId, remainder] of this.remainders) productionRemainders[baseId] = { ...remainder };
    return { stockpiles, productionRemainders, builtMassKg: this.builtMassTotalKg };
  }

  // この台帳で建造を完了した枝の乾燥質量の合計 [kg]。
  public get builtMassKg(): number { return this.builtMassTotalKg; }

  // 建造の完了を記録する。massKg は完成した枝の乾燥質量の合計 [kg] で、評価の
  // 集計としてキャンペーンへ送られる。
  public recordConstructionCompleted(massKg: number): void {
    if (massKg <= 0) return;
    this.builtMassTotalKg += massKg;
    this.events.record({ kind: 'storyConstructionCompleted', massKg });
  }

  // 拠点 baseId の備蓄。項目が無ければ空の備蓄が返る。
  public stockpileOf(baseId: string): BaseStockpile {
    return this.stockpiles.get(baseId) ?? EMPTY_STOCKPILE;
  }

  // 回収などで備蓄へ積む。同期は呼び手が回収の出来事で持つため、ここでは記録しない。
  public credit(baseId: string, materials: number, propellant: number): void {
    const current = this.stockpileOf(baseId);
    this.stockpiles.set(baseId, {
      materials: current.materials + materials, propellant: current.propellant + propellant,
    });
  }

  // 備蓄から支払う。足りなければ何も変えず false が返る。支払えたら増減を記録する。
  public charge(baseId: string, materials: number, propellant: number): boolean {
    const current = this.stockpileOf(baseId);
    if (current.materials < materials || current.propellant < propellant) return false;
    this.stockpiles.set(baseId, {
      materials: current.materials - materials, propellant: current.propellant - propellant,
    });
    if (materials !== 0 || propellant !== 0) {
      this.events.record({
        kind: 'stockpileChanged', baseId,
        materials: materials === 0 ? 0 : -materials, propellant: propellant === 0 ? 0 : -propellant,
      });
    }
    return true;
  }

  // 備蓄へ戻し、増減を記録する。建造途中の取り外しと破棄の返金に使う。
  public refund(baseId: string, materials: number, propellant: number): void {
    this.credit(baseId, materials, propellant);
    if (materials !== 0 || propellant !== 0) {
      this.events.record({ kind: 'stockpileChanged', baseId, materials, propellant });
    }
  }

  // dtSeconds [sim s] ぶんの生産を備蓄へ積む。端数は台帳に残し、整数分だけが
  // 備蓄と記録へ出る。
  public produce(
    baseId: string, materialsPerHour: number, propellantPerHour: number, dtSeconds: number,
  ): void {
    if (dtSeconds <= 0) return;
    const remainder = this.remainders.get(baseId) ?? { materials: 0, propellant: 0 };
    const materialsTotal = remainder.materials + (materialsPerHour * dtSeconds) / 3600;
    const propellantTotal = remainder.propellant + (propellantPerHour * dtSeconds) / 3600;
    const materials = Math.floor(materialsTotal);
    const propellant = Math.floor(propellantTotal);
    this.remainders.set(baseId, {
      materials: materialsTotal - materials, propellant: propellantTotal - propellant,
    });
    if (materials === 0 && propellant === 0) return;
    this.credit(baseId, materials, propellant);
    this.events.record({ kind: 'stockpileChanged', baseId, materials, propellant });
  }
}
