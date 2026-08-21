// 推進剤ごとの材料適合性。タンクに使える金属と、推進系が別に要求する資源を持つ。
import { RESOURCES, ResourceId } from './resource';

export interface TankMaterialRequirement {
  readonly propellantId: string;
  readonly name: string;
  // タンク材として使える資源。いずれか1つを持っていれば足りる。
  readonly allowedMaterials: readonly ResourceId[];
  // タンク材とは別に、その推進系が必ず要求する資源。
  readonly requiredResources: readonly ResourceId[];
}

export const TANK_MATERIALS = {
  hydrazine: {
    propellantId: 'hydrazine',
    name: 'ヒドラジン',
    allowedMaterials: ['structural-metal'],
    requiredResources: [],
  },
} satisfies Record<string, TankMaterialRequirement>;

export type PropellantId = keyof typeof TANK_MATERIALS;

// 推進剤として積むものが、在庫の上ではどの資源か。補給はこの資源を質量ぶん引く。
export const PROPELLANT_RESOURCE: Readonly<Record<PropellantId, ResourceId>> = {
  hydrazine: 'hydrazine',
};

export const PROPELLANT_IDS = Object.keys(TANK_MATERIALS) as readonly PropellantId[];

// その推進剤の密度 [kg/m^3]。
export function propellantDensity(propellant: PropellantId): number {
  return RESOURCES[PROPELLANT_RESOURCE[propellant]].density;
}

// volume [m^3] のタンクにその推進剤を満載したときの質量 [kg]。タンクの容量はこの値であって、
// 部品が別に宣言するものではない。
export function propellantTankCapacity(propellant: PropellantId, volume: number): number {
  return volume * propellantDensity(propellant);
}
