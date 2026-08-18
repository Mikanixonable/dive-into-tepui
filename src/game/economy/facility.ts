// 設備の静的事実の表: 電力を消費して入力資源を出力資源に変換する定義(FacilityDef)と、
// 採掘・加工・合成・発電を通した設備の一覧(FACILITIES)、および月面基地が最初から持つ一組。
import { ResourceId } from './resource';

export interface FacilityAmount {
  readonly resourceId: ResourceId;
  readonly rate: number; // kg/s
}

export interface FacilityBuildCost {
  readonly resourceId: ResourceId;
  readonly mass: number; // kg
}

export interface FacilityDef {
  readonly id: string;
  readonly name: string;
  readonly inputs: readonly FacilityAmount[];
  readonly outputs: readonly FacilityAmount[];
  readonly powerDraw: number; // W
  readonly buildCost: readonly FacilityBuildCost[];
  // これを作るのに要る別の設備。技術の前提ではなく物理的な前提だけを表す。
  readonly requiresFacility: readonly string[];
}

const TONNE = 1000; // [kg]

// 消費電力の段階 [W]。設備の一覧が持つ 小/中/大/極大 に対応する。
const POWER_SMALL = 5e4;
const POWER_MEDIUM = 2e5;
const POWER_LARGE = 1.5e6;
const POWER_HUGE = 1e7;

// 処理速度の段階 [kg/s]。採掘・一次処理・精密加工・微量抽出に対応する。
const RATE_MINING = 5e-2;
const RATE_PROCESS = 2e-2;
const RATE_FINE = 2e-3;
const RATE_TRACE = 1e-6;

export const FACILITIES = {
  // 採掘と一次処理
  'regolith-miner': {
    id: 'regolith-miner',
    name: 'レゴリス採掘機',
    inputs: [],
    outputs: [{ resourceId: 'regolith', rate: RATE_MINING }],
    powerDraw: POWER_MEDIUM,
    buildCost: [
      { resourceId: 'iron', mass: 2 * TONNE },
      { resourceId: 'aluminium', mass: 1 * TONNE },
    ],
    requiresFacility: [],
  },
  'apatite-miner': {
    id: 'apatite-miner',
    name: 'アパタイト採掘機',
    inputs: [],
    outputs: [{ resourceId: 'apatite', rate: RATE_MINING }],
    powerDraw: POWER_MEDIUM,
    buildCost: [
      { resourceId: 'iron', mass: 2 * TONNE },
      { resourceId: 'aluminium', mass: 1 * TONNE },
      { resourceId: 'titanium', mass: 0.3 * TONNE },
    ],
    requiresFacility: [],
  },
  'molten-salt-preparation': {
    id: 'molten-salt-preparation',
    name: '溶融塩調製炉',
    inputs: [{ resourceId: 'apatite', rate: RATE_PROCESS }],
    outputs: [
      { resourceId: 'molten-salt', rate: RATE_PROCESS },
      { resourceId: 'fluorine', rate: RATE_FINE },
      { resourceId: 'phosphorus', rate: RATE_FINE },
    ],
    powerDraw: POWER_MEDIUM,
    buildCost: [
      { resourceId: 'iron', mass: 3 * TONNE },
      { resourceId: 'titanium', mass: 1 * TONNE },
    ],
    requiresFacility: [],
  },
  'ice-miner': {
    id: 'ice-miner',
    name: '氷採掘機',
    inputs: [],
    outputs: [{ resourceId: 'water', rate: RATE_MINING }],
    powerDraw: POWER_MEDIUM,
    buildCost: [
      { resourceId: 'iron', mass: 2 * TONNE },
      { resourceId: 'aluminium', mass: 1 * TONNE },
    ],
    requiresFacility: [],
  },
  'regolith-heat-extraction': {
    id: 'regolith-heat-extraction',
    name: 'レゴリス加熱抽出設備',
    inputs: [{ resourceId: 'regolith', rate: RATE_MINING }],
    outputs: [
      { resourceId: 'helium', rate: RATE_TRACE },
      { resourceId: 'hydrogen', rate: RATE_TRACE },
      { resourceId: 'carbon', rate: RATE_TRACE },
      { resourceId: 'nitrogen', rate: RATE_TRACE },
    ],
    powerDraw: POWER_HUGE,
    buildCost: [
      { resourceId: 'iron', mass: 4 * TONNE },
      { resourceId: 'titanium', mass: 1 * TONNE },
    ],
    requiresFacility: [],
  },
  'molten-salt-electrolysis': {
    id: 'molten-salt-electrolysis',
    name: '溶融塩電解炉',
    inputs: [
      { resourceId: 'regolith', rate: RATE_PROCESS },
      { resourceId: 'molten-salt', rate: RATE_FINE },
    ],
    outputs: [
      { resourceId: 'oxygen', rate: RATE_FINE },
      { resourceId: 'metal-mixture', rate: RATE_PROCESS },
    ],
    powerDraw: POWER_LARGE,
    buildCost: [
      { resourceId: 'iron', mass: 5 * TONNE },
      { resourceId: 'titanium', mass: 2 * TONNE },
      { resourceId: 'electronics', mass: 0.2 * TONNE },
    ],
    requiresFacility: [],
  },
  smelter: {
    id: 'smelter',
    name: '製錬炉',
    inputs: [{ resourceId: 'metal-mixture', rate: RATE_PROCESS }],
    outputs: [
      { resourceId: 'aluminium', rate: RATE_FINE },
      { resourceId: 'iron', rate: RATE_FINE },
      { resourceId: 'titanium', rate: RATE_FINE },
      { resourceId: 'silicon', rate: RATE_FINE },
      { resourceId: 'magnesium', rate: RATE_FINE },
    ],
    powerDraw: POWER_LARGE,
    buildCost: [
      { resourceId: 'iron', mass: 6 * TONNE },
      { resourceId: 'titanium', mass: 2 * TONNE },
    ],
    requiresFacility: [],
  },
  'water-electrolysis': {
    id: 'water-electrolysis',
    name: '水の電解装置',
    inputs: [{ resourceId: 'water', rate: RATE_PROCESS }],
    outputs: [
      { resourceId: 'hydrogen', rate: RATE_FINE },
      { resourceId: 'oxygen', rate: RATE_PROCESS },
    ],
    powerDraw: POWER_LARGE,
    buildCost: [
      { resourceId: 'iron', mass: 1 * TONNE },
      { resourceId: 'platinum-group', mass: 0.02 * TONNE },
    ],
    requiresFacility: [],
  },
  'nuclear-fuel-refinery': {
    id: 'nuclear-fuel-refinery',
    name: '核燃料精製炉',
    inputs: [{ resourceId: 'kreep-rock', rate: RATE_PROCESS }],
    outputs: [
      { resourceId: 'uranium', rate: RATE_TRACE },
      { resourceId: 'thorium', rate: RATE_TRACE },
    ],
    powerDraw: POWER_LARGE,
    buildCost: [
      { resourceId: 'titanium', mass: 3 * TONNE },
      { resourceId: 'platinum-group', mass: 0.1 * TONNE },
    ],
    requiresFacility: [],
  },
  'atmosphere-scoop': {
    id: 'atmosphere-scoop',
    name: '大気捕集機',
    inputs: [],
    // 何が採れるかは天体に依るため、産出は DEPOSITS の 'atmosphere' が持つ。
    outputs: [],
    powerDraw: POWER_LARGE,
    buildCost: [
      { resourceId: 'titanium', mass: 4 * TONNE },
      { resourceId: 'carbon-composite', mass: 2 * TONNE },
    ],
    requiresFacility: [],
  },

  // 素材の加工
  'rolling-mill': {
    id: 'rolling-mill',
    name: '圧延・成形機',
    inputs: [
      { resourceId: 'aluminium', rate: RATE_PROCESS },
      { resourceId: 'iron', rate: RATE_PROCESS },
      { resourceId: 'titanium', rate: RATE_FINE },
      { resourceId: 'magnesium', rate: RATE_FINE },
    ],
    outputs: [
      { resourceId: 'tank-shell', rate: RATE_FINE },
      { resourceId: 'hull-panel', rate: RATE_FINE },
      { resourceId: 'truss-member', rate: RATE_FINE },
    ],
    powerDraw: POWER_MEDIUM,
    buildCost: [
      { resourceId: 'iron', mass: 4 * TONNE },
      { resourceId: 'titanium', mass: 1 * TONNE },
    ],
    requiresFacility: [],
  },
  'machine-shop': {
    id: 'machine-shop',
    name: '機械工場',
    inputs: [
      { resourceId: 'iron', rate: RATE_FINE },
      { resourceId: 'titanium', rate: RATE_FINE },
      { resourceId: 'truss-member', rate: RATE_FINE },
    ],
    outputs: [{ resourceId: 'machinery', rate: RATE_FINE }],
    powerDraw: POWER_MEDIUM,
    buildCost: [
      { resourceId: 'iron', mass: 8 * TONNE },
      { resourceId: 'titanium', mass: 3 * TONNE },
      { resourceId: 'aluminium', mass: 2 * TONNE },
    ],
    requiresFacility: ['rolling-mill'],
  },
  'electronics-factory': {
    id: 'electronics-factory',
    name: '電子機器工場',
    inputs: [
      { resourceId: 'silicon', rate: RATE_FINE },
      { resourceId: 'aluminium', rate: RATE_FINE },
      { resourceId: 'platinum-group', rate: RATE_TRACE },
    ],
    outputs: [{ resourceId: 'electronics', rate: RATE_FINE }],
    powerDraw: POWER_MEDIUM,
    buildCost: [
      { resourceId: 'iron', mass: 4 * TONNE },
      { resourceId: 'silicon', mass: 1 * TONNE },
      { resourceId: 'titanium', mass: 0.5 * TONNE },
    ],
    requiresFacility: [],
  },
  'winding-factory': {
    id: 'winding-factory',
    name: '巻線工場',
    // 製品ごとの要求資源は ACTUATOR_MATERIALS が正本で、ここは工場全体の入力を持つ。
    inputs: [
      { resourceId: 'aluminium', rate: RATE_FINE },
      { resourceId: 'iron', rate: RATE_FINE },
      { resourceId: 'rare-earth', rate: RATE_TRACE },
    ],
    outputs: [
      { resourceId: 'magnetorquer-coil', rate: RATE_FINE },
      { resourceId: 'flywheel-motor', rate: RATE_FINE },
    ],
    powerDraw: POWER_MEDIUM,
    buildCost: [
      { resourceId: 'iron', mass: 5 * TONNE },
      { resourceId: 'aluminium', mass: 2 * TONNE },
    ],
    requiresFacility: [],
  },
  'carbon-fiber-furnace': {
    id: 'carbon-fiber-furnace',
    name: '炭素繊維製造炉',
    inputs: [{ resourceId: 'carbon', rate: RATE_FINE }],
    outputs: [{ resourceId: 'carbon-composite', rate: RATE_FINE }],
    powerDraw: POWER_LARGE,
    buildCost: [
      { resourceId: 'iron', mass: 3 * TONNE },
      { resourceId: 'titanium', mass: 2 * TONNE },
    ],
    requiresFacility: [],
  },
  'polymer-furnace': {
    id: 'polymer-furnace',
    name: '高分子合成炉',
    inputs: [
      { resourceId: 'carbon', rate: RATE_FINE },
      { resourceId: 'hydrogen', rate: RATE_TRACE },
    ],
    outputs: [
      { resourceId: 'abs-resin', rate: RATE_FINE },
      { resourceId: 'htpb', rate: RATE_FINE },
    ],
    powerDraw: POWER_MEDIUM,
    buildCost: [{ resourceId: 'iron', mass: 2 * TONNE }],
    requiresFacility: [],
  },
  'catalyst-bed-furnace': {
    id: 'catalyst-bed-furnace',
    name: '触媒床製造炉',
    inputs: [{ resourceId: 'platinum-group', rate: RATE_TRACE }],
    outputs: [{ resourceId: 'catalyst-bed', rate: RATE_TRACE }],
    powerDraw: POWER_MEDIUM,
    buildCost: [
      { resourceId: 'iron', mass: 1 * TONNE },
      { resourceId: 'platinum-group', mass: 0.05 * TONNE },
    ],
    requiresFacility: [],
  },
  'solar-cell-furnace': {
    id: 'solar-cell-furnace',
    name: '太陽電池製造炉',
    inputs: [{ resourceId: 'silicon', rate: RATE_FINE }],
    outputs: [{ resourceId: 'solar-panel', rate: RATE_FINE }],
    powerDraw: POWER_MEDIUM,
    buildCost: [
      { resourceId: 'iron', mass: 3 * TONNE },
      { resourceId: 'silicon', mass: 1 * TONNE },
      { resourceId: 'electronics', mass: 0.1 * TONNE },
    ],
    requiresFacility: [],
  },

  // 推進剤の合成
  liquefier: {
    id: 'liquefier',
    name: '液化装置',
    inputs: [
      { resourceId: 'hydrogen', rate: RATE_FINE },
      { resourceId: 'oxygen', rate: RATE_FINE },
      { resourceId: 'methane', rate: RATE_FINE },
      { resourceId: 'nitrogen', rate: RATE_FINE },
      { resourceId: 'helium', rate: RATE_TRACE },
    ],
    outputs: [{ resourceId: 'cryogenic-propellant', rate: RATE_PROCESS }],
    powerDraw: POWER_LARGE,
    buildCost: [
      { resourceId: 'titanium', mass: 2 * TONNE },
      { resourceId: 'aluminium', mass: 2 * TONNE },
    ],
    requiresFacility: [],
  },
  'silane-furnace': {
    id: 'silane-furnace',
    name: 'シラン合成炉',
    inputs: [
      { resourceId: 'silicon', rate: RATE_FINE },
      { resourceId: 'hydrogen', rate: RATE_TRACE },
    ],
    outputs: [{ resourceId: 'silane', rate: RATE_FINE }],
    powerDraw: POWER_MEDIUM,
    buildCost: [
      { resourceId: 'iron', mass: 2 * TONNE },
      { resourceId: 'silicon', mass: 0.5 * TONNE },
    ],
    requiresFacility: [],
  },
  'sabatier-reactor': {
    id: 'sabatier-reactor',
    name: 'サバティエ反応器',
    inputs: [
      { resourceId: 'carbon-dioxide', rate: RATE_FINE },
      { resourceId: 'hydrogen', rate: RATE_TRACE },
    ],
    outputs: [
      { resourceId: 'methane', rate: RATE_FINE },
      { resourceId: 'water', rate: RATE_FINE },
    ],
    powerDraw: POWER_MEDIUM,
    buildCost: [
      { resourceId: 'iron', mass: 2 * TONNE },
      { resourceId: 'catalyst-bed', mass: 0.02 * TONNE },
    ],
    requiresFacility: [],
  },
  'ammonia-furnace': {
    id: 'ammonia-furnace',
    name: 'アンモニア合成炉',
    inputs: [
      { resourceId: 'nitrogen', rate: RATE_FINE },
      { resourceId: 'hydrogen', rate: RATE_TRACE },
    ],
    outputs: [{ resourceId: 'ammonia', rate: RATE_FINE }],
    powerDraw: POWER_LARGE,
    buildCost: [
      { resourceId: 'iron', mass: 3 * TONNE },
      { resourceId: 'catalyst-bed', mass: 0.05 * TONNE },
    ],
    requiresFacility: [],
  },
  'hydrazine-furnace': {
    id: 'hydrazine-furnace',
    name: 'ヒドラジン合成炉',
    inputs: [{ resourceId: 'ammonia', rate: RATE_FINE }],
    outputs: [{ resourceId: 'hydrazine', rate: RATE_FINE }],
    powerDraw: POWER_MEDIUM,
    buildCost: [
      { resourceId: 'iron', mass: 2 * TONNE },
      { resourceId: 'catalyst-bed', mass: 0.02 * TONNE },
    ],
    requiresFacility: [],
  },
  'nitric-oxidizer-furnace': {
    id: 'nitric-oxidizer-furnace',
    name: '硝酸酸化炉',
    inputs: [
      { resourceId: 'nitrogen', rate: RATE_FINE },
      { resourceId: 'oxygen', rate: RATE_FINE },
    ],
    outputs: [{ resourceId: 'nitrogen-tetroxide', rate: RATE_FINE }],
    powerDraw: POWER_MEDIUM,
    buildCost: [{ resourceId: 'titanium', mass: 2 * TONNE }],
    requiresFacility: [],
  },
  'solid-grain-press': {
    id: 'solid-grain-press',
    name: '固体グレイン成形機',
    inputs: [
      { resourceId: 'aluminium', rate: RATE_FINE },
      { resourceId: 'ammonium-perchlorate', rate: RATE_FINE },
      { resourceId: 'htpb', rate: RATE_FINE },
    ],
    outputs: [{ resourceId: 'solid-propellant', rate: RATE_FINE }],
    powerDraw: POWER_SMALL,
    buildCost: [{ resourceId: 'iron', mass: 2 * TONNE }],
    requiresFacility: [],
  },
  'perchlorate-furnace': {
    id: 'perchlorate-furnace',
    name: '過塩素酸塩合成炉',
    inputs: [
      { resourceId: 'chlorine', rate: RATE_FINE },
      { resourceId: 'oxygen', rate: RATE_FINE },
    ],
    outputs: [{ resourceId: 'ammonium-perchlorate', rate: RATE_FINE }],
    powerDraw: POWER_MEDIUM,
    buildCost: [{ resourceId: 'titanium', mass: 1 * TONNE }],
    requiresFacility: [],
  },
  'deuterium-separator': {
    id: 'deuterium-separator',
    name: '重水素分離装置',
    inputs: [{ resourceId: 'water', rate: RATE_PROCESS }],
    outputs: [
      { resourceId: 'heavy-water', rate: RATE_TRACE },
      { resourceId: 'deuterium', rate: RATE_TRACE },
    ],
    powerDraw: POWER_HUGE,
    buildCost: [
      { resourceId: 'titanium', mass: 4 * TONNE },
      { resourceId: 'rare-earth', mass: 0.2 * TONNE },
    ],
    requiresFacility: [],
  },
  'helium-isotope-separator': {
    id: 'helium-isotope-separator',
    name: 'ヘリウム同位体分離装置',
    inputs: [{ resourceId: 'helium', rate: RATE_TRACE }],
    outputs: [{ resourceId: 'helium-3', rate: RATE_TRACE }],
    powerDraw: POWER_HUGE,
    buildCost: [
      { resourceId: 'titanium', mass: 5 * TONNE },
      { resourceId: 'rare-earth', mass: 0.5 * TONNE },
      { resourceId: 'superconductor', mass: 0.1 * TONNE },
    ],
    requiresFacility: [],
  },

  // 発電と区画
  'power-grid': {
    id: 'power-grid',
    name: '送電網',
    inputs: [],
    outputs: [],
    powerDraw: 0,
    buildCost: [{ resourceId: 'aluminium', mass: 1 * TONNE }],
    requiresFacility: [],
  },
  'fission-reactor': {
    id: 'fission-reactor',
    name: '原子炉',
    inputs: [{ resourceId: 'uranium', rate: RATE_TRACE }],
    outputs: [],
    powerDraw: 0,
    buildCost: [
      { resourceId: 'titanium', mass: 5 * TONNE },
      { resourceId: 'platinum-group', mass: 0.2 * TONNE },
      { resourceId: 'rare-earth', mass: 0.1 * TONNE },
    ],
    requiresFacility: [],
  },
  'solar-array': {
    id: 'solar-array',
    name: '太陽電池アレイ',
    inputs: [],
    outputs: [],
    powerDraw: 0,
    buildCost: [{ resourceId: 'solar-panel', mass: 2 * TONNE }],
    requiresFacility: [],
  },
  'fuel-cell-furnace': {
    id: 'fuel-cell-furnace',
    name: '燃料電池製造炉',
    inputs: [
      { resourceId: 'platinum-group', rate: RATE_TRACE },
      { resourceId: 'iron', rate: RATE_FINE },
    ],
    outputs: [{ resourceId: 'fuel-cell', rate: RATE_FINE }],
    powerDraw: POWER_MEDIUM,
    buildCost: [
      { resourceId: 'iron', mass: 2 * TONNE },
      { resourceId: 'platinum-group', mass: 0.05 * TONNE },
    ],
    requiresFacility: [],
  },
  'radioisotope-battery-furnace': {
    id: 'radioisotope-battery-furnace',
    name: '原子力電池製造炉',
    inputs: [
      { resourceId: 'thorium', rate: RATE_TRACE },
      { resourceId: 'titanium', rate: RATE_FINE },
    ],
    outputs: [{ resourceId: 'radioisotope-battery', rate: RATE_FINE }],
    powerDraw: POWER_MEDIUM,
    buildCost: [
      { resourceId: 'titanium', mass: 2 * TONNE },
      { resourceId: 'platinum-group', mass: 0.05 * TONNE },
    ],
    requiresFacility: [],
  },
  'life-support-furnace': {
    id: 'life-support-furnace',
    name: '生命維持装置製造炉',
    inputs: [
      { resourceId: 'iron', rate: RATE_FINE },
      { resourceId: 'titanium', rate: RATE_FINE },
      { resourceId: 'platinum-group', rate: RATE_TRACE },
    ],
    outputs: [{ resourceId: 'life-support', rate: RATE_FINE }],
    powerDraw: POWER_MEDIUM,
    buildCost: [
      { resourceId: 'iron', mass: 3 * TONNE },
      { resourceId: 'titanium', mass: 1 * TONNE },
      { resourceId: 'platinum-group', mass: 0.1 * TONNE },
    ],
    requiresFacility: [],
  },
  'farm-equipment-furnace': {
    id: 'farm-equipment-furnace',
    name: '農場設備製造炉',
    inputs: [
      { resourceId: 'iron', rate: RATE_FINE },
      { resourceId: 'silicon', rate: RATE_FINE },
      { resourceId: 'carbon', rate: RATE_FINE },
      { resourceId: 'abs-resin', rate: RATE_FINE },
      { resourceId: 'phosphorus', rate: RATE_TRACE },
    ],
    outputs: [{ resourceId: 'farm', rate: RATE_FINE }],
    powerDraw: POWER_MEDIUM,
    buildCost: [
      { resourceId: 'iron', mass: 3 * TONNE },
      { resourceId: 'silicon', mass: 1 * TONNE },
    ],
    requiresFacility: ['polymer-furnace'],
  },
  'container-press': {
    id: 'container-press',
    name: 'コンテナ成形機',
    inputs: [
      { resourceId: 'aluminium', rate: RATE_FINE },
      { resourceId: 'iron', rate: RATE_FINE },
    ],
    outputs: [{ resourceId: 'container', rate: RATE_FINE }],
    powerDraw: POWER_SMALL,
    buildCost: [{ resourceId: 'iron', mass: 2 * TONNE }],
    requiresFacility: [],
  },
  'water-tank-press': {
    id: 'water-tank-press',
    name: '水タンク成形機',
    inputs: [
      { resourceId: 'aluminium', rate: RATE_FINE },
      { resourceId: 'iron', rate: RATE_FINE },
    ],
    outputs: [{ resourceId: 'water-tank', rate: RATE_FINE }],
    powerDraw: POWER_SMALL,
    buildCost: [{ resourceId: 'iron', mass: 2 * TONNE }],
    requiresFacility: [],
  },
  'dock-structure-furnace': {
    id: 'dock-structure-furnace',
    name: 'ドック構造製造炉',
    inputs: [
      { resourceId: 'iron', rate: RATE_FINE },
      { resourceId: 'titanium', rate: RATE_FINE },
      { resourceId: 'aluminium', rate: RATE_FINE },
    ],
    outputs: [{ resourceId: 'dock', rate: RATE_FINE }],
    powerDraw: POWER_MEDIUM,
    buildCost: [
      { resourceId: 'iron', mass: 5 * TONNE },
      { resourceId: 'titanium', mass: 2 * TONNE },
    ],
    requiresFacility: [],
  },
  'assembly-dock': {
    id: 'assembly-dock',
    name: '組立ドック',
    inputs: [],
    outputs: [],
    powerDraw: POWER_MEDIUM,
    buildCost: [{ resourceId: 'dock', mass: 5 * TONNE }],
    requiresFacility: ['dock-structure-furnace'],
  },
  'ammunition-furnace': {
    id: 'ammunition-furnace',
    name: '弾薬製造炉',
    inputs: [
      { resourceId: 'iron', rate: RATE_FINE },
      { resourceId: 'aluminium', rate: RATE_FINE },
      { resourceId: 'htpb', rate: RATE_FINE },
    ],
    outputs: [{ resourceId: 'ammunition', rate: RATE_FINE }],
    powerDraw: POWER_MEDIUM,
    buildCost: [{ resourceId: 'iron', mass: 3 * TONNE }],
    requiresFacility: ['machine-shop'],
  },
} satisfies Record<string, FacilityDef>;

export type FacilityId = keyof typeof FACILITIES;

export const FACILITY_IDS = Object.keys(FACILITIES) as readonly FacilityId[];

// 月面基地が地球から運ばれた最初の一組として持つ設備。以後のすべてはこれらから作る。
export const INITIAL_FACILITY_IDS: readonly FacilityId[] = [
  'solar-array',
  'power-grid',
  'ice-miner',
  'apatite-miner',
  'molten-salt-preparation',
  'molten-salt-electrolysis',
  'smelter',
  'rolling-mill',
  'assembly-dock',
];

// id を表から引く。表に無い id を渡すと例外になる。
export function facilityDef(id: FacilityId): FacilityDef {
  const def = FACILITIES[id];
  if (def === undefined) throw new Error(`facilityDef: 登録されていない設備 id: ${id}`);
  return def;
}
