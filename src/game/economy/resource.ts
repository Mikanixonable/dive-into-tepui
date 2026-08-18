// 資源の静的事実の表: 貯蔵の性格と容積計算に要る密度(ResourceDef)と、
// 元素・鉱石・中間素材・部材を通した資源の一覧(RESOURCES)。

// 貯蔵の性格。容器と取り扱いの制約がここで決まる。
export type ResourceStorage = 'bulk' | 'cryogenic' | 'pressurized' | 'hazardous';

export interface ResourceDef {
  readonly id: string;
  readonly name: string;
  readonly symbol: string; // 元素記号または化学式
  readonly density: number; // kg/m^3
  readonly storage: ResourceStorage;
}

export const RESOURCES = {
  // 元素
  hydrogen: { id: 'hydrogen', name: '水素', symbol: 'H', density: 70.8, storage: 'cryogenic' },
  oxygen: { id: 'oxygen', name: '酸素', symbol: 'O', density: 1141, storage: 'cryogenic' },
  carbon: { id: 'carbon', name: '炭素', symbol: 'C', density: 2260, storage: 'bulk' },
  nitrogen: { id: 'nitrogen', name: '窒素', symbol: 'N', density: 807, storage: 'cryogenic' },
  silicon: { id: 'silicon', name: 'ケイ素', symbol: 'Si', density: 2330, storage: 'bulk' },
  aluminium: { id: 'aluminium', name: 'アルミ', symbol: 'Al', density: 2700, storage: 'bulk' },
  titanium: { id: 'titanium', name: 'チタン', symbol: 'Ti', density: 4506, storage: 'bulk' },
  iron: { id: 'iron', name: '鉄', symbol: 'Fe', density: 7874, storage: 'bulk' },
  magnesium: { id: 'magnesium', name: 'マグネシウム', symbol: 'Mg', density: 1738, storage: 'bulk' },
  fluorine: { id: 'fluorine', name: 'フッ素', symbol: 'F', density: 1505, storage: 'hazardous' },
  chlorine: { id: 'chlorine', name: '塩素', symbol: 'Cl', density: 1562, storage: 'hazardous' },
  phosphorus: { id: 'phosphorus', name: 'リン', symbol: 'P', density: 1823, storage: 'bulk' },
  sulfur: { id: 'sulfur', name: '硫黄', symbol: 'S', density: 2070, storage: 'bulk' },
  copper: { id: 'copper', name: '銅', symbol: 'Cu', density: 8960, storage: 'bulk' },
  nickel: { id: 'nickel', name: 'ニッケル', symbol: 'Ni', density: 8908, storage: 'bulk' },
  helium: { id: 'helium', name: 'ヘリウム', symbol: 'He', density: 125, storage: 'cryogenic' },
  'helium-3': { id: 'helium-3', name: 'ヘリウム3', symbol: '3He', density: 59, storage: 'cryogenic' },
  deuterium: { id: 'deuterium', name: '重水素', symbol: 'D', density: 162, storage: 'cryogenic' },
  'platinum-group': { id: 'platinum-group', name: '白金族', symbol: 'Pt', density: 21450, storage: 'bulk' },
  thorium: { id: 'thorium', name: 'トリウム', symbol: 'Th', density: 11720, storage: 'hazardous' },
  uranium: { id: 'uranium', name: 'ウラン', symbol: 'U', density: 19050, storage: 'hazardous' },
  'rare-earth': { id: 'rare-earth', name: '希土類', symbol: 'RE', density: 7000, storage: 'bulk' },
  xenon: { id: 'xenon', name: 'キセノン', symbol: 'Xe', density: 1560, storage: 'pressurized' },
  argon: { id: 'argon', name: 'アルゴン', symbol: 'Ar', density: 1400, storage: 'pressurized' },
  water: { id: 'water', name: '水', symbol: 'H2O', density: 1000, storage: 'bulk' },

  // 採掘したままの鉱石と、採取した大気成分
  regolith: { id: 'regolith', name: 'レゴリス', symbol: 'regolith', density: 1500, storage: 'bulk' },
  apatite: { id: 'apatite', name: 'アパタイト', symbol: 'Ca5(PO4)3(F,Cl)', density: 3190, storage: 'bulk' },
  'kreep-rock': { id: 'kreep-rock', name: 'KREEP岩', symbol: 'KREEP', density: 2900, storage: 'bulk' },
  'm-type-ore': { id: 'm-type-ore', name: 'M型小惑星の鉱石', symbol: 'M-ore', density: 5000, storage: 'bulk' },
  organics: { id: 'organics', name: '有機物', symbol: 'CHO', density: 1100, storage: 'bulk' },
  'carbon-dioxide': { id: 'carbon-dioxide', name: '二酸化炭素', symbol: 'CO2', density: 1101, storage: 'pressurized' },

  // 一次処理で得る中間物
  'molten-salt': { id: 'molten-salt', name: '溶融塩', symbol: 'CaCl2', density: 2150, storage: 'bulk' },
  'metal-mixture': { id: 'metal-mixture', name: '金属の混合物', symbol: 'M', density: 4000, storage: 'bulk' },

  // 推進剤と化学品
  methane: { id: 'methane', name: 'メタン', symbol: 'CH4', density: 422, storage: 'cryogenic' },
  silane: { id: 'silane', name: 'シラン', symbol: 'SiH4', density: 680, storage: 'hazardous' },
  ammonia: { id: 'ammonia', name: 'アンモニア', symbol: 'NH3', density: 682, storage: 'pressurized' },
  hydrazine: { id: 'hydrazine', name: 'ヒドラジン', symbol: 'N2H4', density: 1021, storage: 'hazardous' },
  'nitrogen-tetroxide': {
    id: 'nitrogen-tetroxide',
    name: '四酸化二窒素',
    symbol: 'N2O4',
    density: 1443,
    storage: 'hazardous',
  },
  'hydrogen-peroxide': {
    id: 'hydrogen-peroxide',
    name: '過酸化水素',
    symbol: 'H2O2',
    density: 1450,
    storage: 'hazardous',
  },
  'ammonium-perchlorate': {
    id: 'ammonium-perchlorate',
    name: '過塩素酸アンモニウム',
    symbol: 'NH4ClO4',
    density: 1950,
    storage: 'hazardous',
  },
  'solid-propellant': {
    id: 'solid-propellant',
    name: '固体推進剤',
    symbol: 'grain',
    density: 1750,
    storage: 'hazardous',
  },
  'heavy-water': { id: 'heavy-water', name: '重水', symbol: 'D2O', density: 1107, storage: 'bulk' },
  'cryogenic-propellant': {
    id: 'cryogenic-propellant',
    name: '極低温液体',
    symbol: 'cryo',
    density: 500,
    storage: 'cryogenic',
  },

  // 加工した部材と機器
  'tank-shell': { id: 'tank-shell', name: 'タンク殻', symbol: 'shell', density: 2700, storage: 'bulk' },
  'hull-panel': { id: 'hull-panel', name: '外皮パネル', symbol: 'panel', density: 2700, storage: 'bulk' },
  'truss-member': { id: 'truss-member', name: 'トラス部材', symbol: 'truss', density: 2700, storage: 'bulk' },
  machinery: { id: 'machinery', name: '機械部品', symbol: 'mech', density: 4500, storage: 'bulk' },
  electronics: { id: 'electronics', name: '電子機器', symbol: 'elec', density: 2000, storage: 'bulk' },
  'magnetorquer-coil': {
    id: 'magnetorquer-coil',
    name: '磁気トルカのコイル',
    symbol: 'coil',
    density: 4000,
    storage: 'bulk',
  },
  'flywheel-motor': {
    id: 'flywheel-motor',
    name: 'フライホイールのモーター',
    symbol: 'motor',
    density: 5000,
    storage: 'bulk',
  },
  'carbon-composite': {
    id: 'carbon-composite',
    name: '炭素繊維複合材',
    symbol: 'CFRP',
    density: 1600,
    storage: 'bulk',
  },
  'abs-resin': { id: 'abs-resin', name: 'ABS樹脂', symbol: 'ABS', density: 1040, storage: 'bulk' },
  htpb: { id: 'htpb', name: '末端水酸基ポリブタジエン', symbol: 'HTPB', density: 920, storage: 'bulk' },
  'catalyst-bed': { id: 'catalyst-bed', name: '触媒床', symbol: 'cat', density: 3000, storage: 'bulk' },
  'solar-panel': { id: 'solar-panel', name: '太陽電池パドル', symbol: 'PV', density: 1800, storage: 'bulk' },
  'fuel-cell': { id: 'fuel-cell', name: '燃料電池', symbol: 'FC', density: 2500, storage: 'bulk' },
  'radioisotope-battery': {
    id: 'radioisotope-battery',
    name: '原子力電池',
    symbol: 'RTG',
    density: 6000,
    storage: 'hazardous',
  },
  'life-support': { id: 'life-support', name: '生命維持装置', symbol: 'ECLSS', density: 1500, storage: 'bulk' },
  farm: { id: 'farm', name: '農場', symbol: 'farm', density: 800, storage: 'bulk' },
  container: { id: 'container', name: 'コンテナ', symbol: 'cont', density: 2700, storage: 'bulk' },
  'water-tank': { id: 'water-tank', name: '水タンク', symbol: 'wtank', density: 2700, storage: 'bulk' },
  dock: { id: 'dock', name: 'ドック', symbol: 'dock', density: 3000, storage: 'bulk' },
  ammunition: { id: 'ammunition', name: '弾薬', symbol: 'ammo', density: 3500, storage: 'hazardous' },
  superconductor: { id: 'superconductor', name: '超伝導材', symbol: 'SC', density: 6500, storage: 'bulk' },
} satisfies Record<string, ResourceDef>;

// 資源の id。
export type ResourceId = keyof typeof RESOURCES;

export const RESOURCE_IDS = Object.keys(RESOURCES) as readonly ResourceId[];

// id を表から引く。表に無い id を渡すと例外になる。
export function resourceDef(id: ResourceId): ResourceDef {
  const def = RESOURCES[id];
  if (def === undefined) throw new Error(`resourceDef: 登録されていない資源 id: ${id}`);
  return def;
}
