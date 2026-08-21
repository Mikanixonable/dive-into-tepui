// 設備の静的事実の表: 電力を消費して入力資源を出力資源に変換する定義(FacilityDef)と、
// 基地が最初から持つ一組(FACILITIES)。
import { ResourceId } from './resource';

// 出入りする資源の量。
export interface FacilityAmount {
  readonly resourceId: ResourceId;
  readonly rate: number; // kg/s
}

// 入力の1枠。anyOf は同じ役を果たす資源の並びで、そのうち1つを消費すれば足りる。
export interface FacilityInput {
  readonly anyOf: readonly ResourceId[];
  readonly rate: number; // kg/s
}

export interface FacilityBuildCost {
  readonly resourceId: ResourceId;
  readonly mass: number; // kg
}

export interface FacilityDef {
  readonly id: string;
  readonly name: string;
  readonly inputs: readonly FacilityInput[];
  readonly outputs: readonly FacilityAmount[];
  readonly powerDraw: number; // W。動かすのに要る電力
  readonly powerOutput: number; // W。発電設備が出す電力
  readonly buildCost: readonly FacilityBuildCost[];
  // これを作るのに要る別の設備。技術の前提ではなく物理的な前提だけを表す。
  readonly requiresFacility: readonly FacilityId[];
}

// 発電量の段階 [W]。太陽電池アレイ1面ぶん。
const POWER_OUTPUT_SOLAR_ARRAY = 2e6;
const POWER_MEDIUM = 2e5;

// 表のリテラルから id の集合を取り出すための素の値。FacilityDef としての検査は FACILITIES で受ける。
const FACILITY_DEFS = {
  'solar-array': {
    id: 'solar-array',
    name: '太陽電池アレイ',
    inputs: [],
    outputs: [],
    powerDraw: 0,
    powerOutput: POWER_OUTPUT_SOLAR_ARRAY,
    buildCost: [],
    requiresFacility: [],
  },
  'assembly-dock': {
    id: 'assembly-dock',
    name: '組立ドック',
    inputs: [],
    outputs: [],
    powerDraw: POWER_MEDIUM,
    powerOutput: 0,
    buildCost: [],
    requiresFacility: [],
  },
} as const;

export type FacilityId = keyof typeof FACILITY_DEFS;

export const FACILITIES: Record<FacilityId, FacilityDef> = FACILITY_DEFS;

export const FACILITY_IDS = Object.keys(FACILITIES) as readonly FacilityId[];

// 基地が最初から持つ設備。
export const INITIAL_FACILITY_IDS: readonly FacilityId[] = ['solar-array', 'assembly-dock'];

// id を表から引く。表に無い id を渡すと例外になる。
export function facilityDef(id: FacilityId): FacilityDef {
  const def = FACILITIES[id];
  if (def === undefined) throw new Error(`facilityDef: 登録されていない設備 id: ${id}`);
  return def;
}
