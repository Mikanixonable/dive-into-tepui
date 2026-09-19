// 軌道ガイドが軌道の種類をまとめる群と、ガイドを描ける系の語彙。
import type { CatalogSystemId } from '../../../physics/orbit-catalog';

// ガイドを描ける CR3BP の系。
export const GUIDE_SYSTEMS: readonly CatalogSystemId[] = [
  'earth-moon', 'sun-earth', 'sun-mars', 'jupiter-europa', 'saturn-titan', 'saturn-enceladus', 'mars-phobos',
];

export type GuideGroupId = 'collinear' | 'triangular' | 'secondary' | 'resonant';

export const GUIDE_GROUPS: readonly GuideGroupId[] = ['collinear', 'triangular', 'secondary', 'resonant'];
