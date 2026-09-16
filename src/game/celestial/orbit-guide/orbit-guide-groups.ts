// 軌道ガイドが軌道の種類をまとめる群の語彙。

export type GuideGroupId = 'collinear' | 'triangular' | 'secondary' | 'resonant';

export const GUIDE_GROUPS: readonly GuideGroupId[] = ['collinear', 'triangular', 'secondary', 'resonant'];
