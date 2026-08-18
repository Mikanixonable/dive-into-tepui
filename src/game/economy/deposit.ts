// 産地の表: どの天体から何が採れるか(DEPOSITS)と、天体に紐づかない敵のドロップ(ENEMY_DROPS)。
import { AttractorId } from '../../physics/attractor';
import { ResourceId } from './resource';

// 採取の手段。'atmosphere' は着陸を要さず大気捕集機で採る。
export type DepositAccess = 'surface' | 'atmosphere' | 'regolith';

export interface DepositDef {
  readonly bodyId: AttractorId;
  readonly resourceId: ResourceId;
  readonly abundance: number; // 採掘機1基あたりの産出速度の係数
  readonly access: DepositAccess;
}

export const DEPOSITS: readonly DepositDef[] = [
  // 月。レゴリスとアパタイトと永久影の氷、そして産出量の少ない KREEP 岩。
  { bodyId: 'moon', resourceId: 'regolith', abundance: 1, access: 'regolith' },
  { bodyId: 'moon', resourceId: 'apatite', abundance: 0.3, access: 'surface' },
  { bodyId: 'moon', resourceId: 'water', abundance: 0.4, access: 'surface' },
  { bodyId: 'moon', resourceId: 'kreep-rock', abundance: 0.1, access: 'surface' },
  { bodyId: 'moon', resourceId: 'rare-earth', abundance: 0.02, access: 'surface' },

  // 近地球小惑星(C型)。水と炭素と有機物。
  { bodyId: 'bennu', resourceId: 'water', abundance: 0.5, access: 'surface' },
  { bodyId: 'bennu', resourceId: 'carbon', abundance: 0.4, access: 'surface' },
  { bodyId: 'bennu', resourceId: 'organics', abundance: 0.2, access: 'surface' },
  { bodyId: 'ryugu', resourceId: 'water', abundance: 0.5, access: 'surface' },
  { bodyId: 'ryugu', resourceId: 'carbon', abundance: 0.4, access: 'surface' },
  { bodyId: 'ryugu', resourceId: 'organics', abundance: 0.2, access: 'surface' },

  // M型小惑星。金属と白金族と希土類。
  { bodyId: 'psyche', resourceId: 'm-type-ore', abundance: 1, access: 'surface' },
  { bodyId: 'psyche', resourceId: 'iron', abundance: 0.8, access: 'surface' },
  { bodyId: 'psyche', resourceId: 'nickel', abundance: 0.3, access: 'surface' },
  { bodyId: 'psyche', resourceId: 'copper', abundance: 0.1, access: 'surface' },
  { bodyId: 'psyche', resourceId: 'platinum-group', abundance: 0.02, access: 'surface' },
  { bodyId: 'psyche', resourceId: 'rare-earth', abundance: 0.05, access: 'surface' },

  // ケレス。小惑星帯で最も水が豊富。
  { bodyId: 'ceres', resourceId: 'water', abundance: 1, access: 'surface' },
  { bodyId: 'ceres', resourceId: 'carbon', abundance: 0.3, access: 'surface' },
  { bodyId: 'ceres', resourceId: 'nitrogen', abundance: 0.2, access: 'surface' },

  // 火星。大気の CO2・N2・Ar と、地表の水氷。
  { bodyId: 'mars', resourceId: 'carbon-dioxide', abundance: 1, access: 'atmosphere' },
  { bodyId: 'mars', resourceId: 'nitrogen', abundance: 0.1, access: 'atmosphere' },
  { bodyId: 'mars', resourceId: 'argon', abundance: 0.07, access: 'atmosphere' },
  // 火星大気のキセノンは 0.08 ppm の桁。電気推進の推進剤としては最初の産地になる。
  { bodyId: 'mars', resourceId: 'xenon', abundance: 0.0001, access: 'atmosphere' },
  { bodyId: 'mars', resourceId: 'water', abundance: 0.3, access: 'surface' },

  // 金星。着陸はせず、大気だけを捕集する。
  { bodyId: 'venus', resourceId: 'nitrogen', abundance: 0.2, access: 'atmosphere' },
  { bodyId: 'venus', resourceId: 'carbon-dioxide', abundance: 1, access: 'atmosphere' },
  { bodyId: 'venus', resourceId: 'sulfur', abundance: 0.1, access: 'atmosphere' },

  // 木星大気。ヘリウムを大量に得られる唯一の産地。
  { bodyId: 'jupiter', resourceId: 'hydrogen', abundance: 1, access: 'atmosphere' },
  { bodyId: 'jupiter', resourceId: 'helium', abundance: 0.4, access: 'atmosphere' },
  { bodyId: 'jupiter', resourceId: 'helium-3', abundance: 0.001, access: 'atmosphere' },
  // 木星大気のキセノンは太陽組成の2倍ほどに濃縮されており、火星より濃い。
  { bodyId: 'jupiter', resourceId: 'xenon', abundance: 0.002, access: 'atmosphere' },

  // 木星の衛星。カリストは放射線が最も弱く、イオは最も強い。
  { bodyId: 'callisto', resourceId: 'water', abundance: 0.8, access: 'surface' },
  { bodyId: 'europa', resourceId: 'water', abundance: 0.8, access: 'surface' },
  { bodyId: 'ganymede', resourceId: 'water', abundance: 0.8, access: 'surface' },
  { bodyId: 'io', resourceId: 'sulfur', abundance: 0.6, access: 'surface' },

  // タイタン。炭素と窒素が事実上無尽蔵。
  { bodyId: 'titan', resourceId: 'methane', abundance: 1, access: 'surface' },
  { bodyId: 'titan', resourceId: 'nitrogen', abundance: 0.8, access: 'atmosphere' },
];

// ドロップ元の敵。天体に紐づかないため、産地とは別に持つ。
export type EnemyDropSourceId = 'drifting' | 'stage0';

export interface EnemyDropDef {
  readonly enemyKind: EnemyDropSourceId;
  readonly drops: readonly { resourceId: ResourceId; massRange: [number, number] }[]; // kg
}

export const ENEMY_DROPS: readonly EnemyDropDef[] = [
  {
    enemyKind: 'drifting',
    drops: [
      { resourceId: 'carbon', massRange: [20, 80] },
      { resourceId: 'nitrogen', massRange: [10, 40] },
      { resourceId: 'sulfur', massRange: [2, 10] },
      { resourceId: 'copper', massRange: [5, 20] },
      { resourceId: 'platinum-group', massRange: [0.1, 1] },
      { resourceId: 'rare-earth', massRange: [0.5, 3] },
    ],
  },
  {
    enemyKind: 'stage0',
    drops: [
      { resourceId: 'carbon', massRange: [5, 20] },
      { resourceId: 'nitrogen', massRange: [2, 10] },
      { resourceId: 'copper', massRange: [1, 5] },
    ],
  },
];
