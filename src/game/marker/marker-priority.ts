// マーカーが重なったときに、どちらを残すかを決める種別ごとの度合い(大きいほど残る)。
// 天体のラベルは船・実体より優先し、軌道上の点はもっとも譲る。
export const MARKER_PRIORITY = {
  STAR_PLANET: 5000,
  DWARF_PLANET: 4000,
  SATELLITE_SMALL_BODY: 3000,
  LAGRANGE: 2000,
  PRIMARY_TARGET: 900,
  IMPACT: 850,
  BASE: 700,
  PLAYER: 600,
  ENEMY: 500,
  AMMO: 300,
  MANEUVER_NODE: 150,
  ORBITAL_NODE: 100,
  PROTEIN_SITE: 50,
  // 種別に応じた度合いを持たないマーカー(方向・照準・目盛・計画位置など)。
  NONE: 0,
} as const;
