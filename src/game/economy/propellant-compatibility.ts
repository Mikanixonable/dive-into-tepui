// 推進剤ごとの材料適合性。タンクに使える金属と、推進系が別に要求する資源を持つ。
import { ResourceId } from './resource';

export interface TankMaterialRequirement {
  readonly propellantId: string;
  readonly name: string;
  // タンク材として使える資源。いずれか1つを持っていれば足りる。
  readonly allowedMaterials: readonly ResourceId[];
  // タンク材とは別に、その推進系が必ず要求する資源。
  readonly requiredResources: readonly ResourceId[];
}

export const TANK_MATERIALS = {
  'liquid-hydrogen': {
    propellantId: 'liquid-hydrogen',
    name: '液体水素',
    // 水素脆化により、ふつうの合金は水素が拡散して脆くなる。
    allowedMaterials: ['aluminium', 'iron'],
    requiredResources: [],
  },
  'nitrogen-tetroxide': {
    propellantId: 'nitrogen-tetroxide',
    name: '四酸化二窒素',
    // チタンとは応力腐食割れを起こすため、チタン製タンクには入れられない。
    allowedMaterials: ['aluminium'],
    requiredResources: [],
  },
  'hydrogen-peroxide': {
    propellantId: 'hydrogen-peroxide',
    name: '過酸化水素',
    // 多くの金属と接触すると分解する。
    allowedMaterials: ['aluminium', 'iron'],
    requiredResources: [],
  },
  'liquid-oxygen': {
    propellantId: 'liquid-oxygen',
    name: '液体酸素',
    allowedMaterials: ['aluminium', 'iron', 'titanium'],
    requiredResources: [],
  },
  'liquid-methane': {
    propellantId: 'liquid-methane',
    name: '液体メタン',
    allowedMaterials: ['aluminium', 'iron', 'titanium'],
    requiredResources: [],
  },
  silane: {
    propellantId: 'silane',
    name: 'シラン',
    allowedMaterials: ['aluminium', 'iron', 'titanium'],
    requiredResources: [],
  },
  hydrazine: {
    propellantId: 'hydrazine',
    name: 'ヒドラジン',
    allowedMaterials: ['aluminium', 'iron'],
    // 触媒床は燃焼室の中にあり、その質量は推力に比例する。推進剤の種別に紐付けると
    // 比例させる相手がその場に無いため、要求はスラスタとエンジンの建造費が持つ(§6-4)。
    requiredResources: [],
  },
} satisfies Record<string, TankMaterialRequirement>;

export type PropellantId = keyof typeof TANK_MATERIALS;

export const PROPELLANT_IDS = Object.keys(TANK_MATERIALS) as readonly PropellantId[];
