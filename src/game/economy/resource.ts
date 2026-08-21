// 資源の静的事実の表: 貯蔵の性格と容積計算に要る密度(ResourceDef)と、
// 部品の建造・構造材・推進剤を通した資源の一覧(RESOURCES)。

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
  // 構造用金属
  'structural-metal': { id: 'structural-metal', name: '構造金属', symbol: 'metal', density: 2700, storage: 'bulk' },
  titanium: { id: 'titanium', name: 'チタン', symbol: 'Ti', density: 4506, storage: 'bulk' },
  'precision-metal': { id: 'precision-metal', name: '精密金属', symbol: 'p-metal', density: 8960, storage: 'bulk' },

  // 推進剤
  hydrazine: { id: 'hydrazine', name: 'ヒドラジン', symbol: 'N2H4', density: 1021, storage: 'hazardous' },

  // 加工した部材と機器
  'tank-shell': { id: 'tank-shell', name: 'タンク殻', symbol: 'shell', density: 2700, storage: 'bulk' },
  'hull-panel': { id: 'hull-panel', name: '外皮パネル', symbol: 'panel', density: 2700, storage: 'bulk' },
  'truss-member': { id: 'truss-member', name: 'トラス部材', symbol: 'truss', density: 2700, storage: 'bulk' },
  machinery: { id: 'machinery', name: '機械部品', symbol: 'mech', density: 4500, storage: 'bulk' },
  electronics: { id: 'electronics', name: '電子機器', symbol: 'elec', density: 2000, storage: 'bulk' },
  'magnetorquer-coil': {
    id: 'magnetorquer-coil', name: '磁気トルカのコイル', symbol: 'coil', density: 4000, storage: 'bulk',
  },
  'flywheel-motor': {
    id: 'flywheel-motor', name: 'フライホイールのモーター', symbol: 'motor', density: 5000, storage: 'bulk',
  },
  'carbon-composite': {
    id: 'carbon-composite', name: '炭素繊維複合材', symbol: 'CFRP', density: 1600, storage: 'bulk',
  },
  'abs-resin': { id: 'abs-resin', name: 'ABS樹脂', symbol: 'ABS', density: 1040, storage: 'bulk' },
  'catalyst-bed': { id: 'catalyst-bed', name: '触媒床', symbol: 'cat', density: 3000, storage: 'bulk' },
  'solar-panel': { id: 'solar-panel', name: '太陽電池パドル', symbol: 'PV', density: 1800, storage: 'bulk' },
  'fuel-cell': { id: 'fuel-cell', name: '燃料電池', symbol: 'FC', density: 2500, storage: 'bulk' },
  'radioisotope-battery': {
    id: 'radioisotope-battery', name: '原子力電池', symbol: 'RTG', density: 6000, storage: 'hazardous',
  },
  'life-support': { id: 'life-support', name: '生命維持装置', symbol: 'ECLSS', density: 1500, storage: 'bulk' },
  farm: { id: 'farm', name: '農場', symbol: 'farm', density: 800, storage: 'bulk' },
  'water-tank': { id: 'water-tank', name: '水タンク', symbol: 'wtank', density: 2700, storage: 'bulk' },
  dock: { id: 'dock', name: 'ドック', symbol: 'dock', density: 3000, storage: 'bulk' },
  ammunition: { id: 'ammunition', name: '弾薬', symbol: 'ammo', density: 3500, storage: 'hazardous' },
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
