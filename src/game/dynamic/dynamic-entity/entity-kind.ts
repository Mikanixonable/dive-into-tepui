// ゲーム内 entity を分類する語彙。マップ表示のトグルが引く種別、同時存在数の枠、
// タンパク質陣形での役割。
export type DynamicEntityKind = 'player' | 'enemy' | 'ammo' | 'fuel' | 'base';

// 同時に存在してよい数の枠。個体は自分がどの枠から取るかを DynamicEntity.capKind で宣言する。
// 種別との対応は多対一でよく、枠の粒度は種別の粒度と独立に決められる。
export type CapKind = 'bullet' | 'casing' | 'debris' | 'booster';

// 個体数を数える枠。枠(capKind)を持つ個体はその枠で、持たない個体は種別(mapKind)で数える。
export type EntityCountKind = CapKind | DynamicEntityKind;

// 枠ごとに同時に存在してよい個体数。超えた分はその枠の古いものから落ちる。
export const ENTITY_CAP: Record<CapKind, number> = {
  bullet: 1200,
  casing: 260,
  debris: 600,
  booster: 64,
};

// タンパク質陣形における敵の役割。
export type FormationRole = 'attacker' | 'shield' | 'energy';
