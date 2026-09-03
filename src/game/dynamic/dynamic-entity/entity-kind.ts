// ゲーム内 entity を分類する2つの語彙。マップ表示のトグルが引く種別と、同時存在数の枠。
export type DynamicEntityKind = 'player' | 'enemy' | 'ammo' | 'fuel' | 'base';

// 同時に存在してよい数の枠。個体は自分がどの枠から取るかを DynamicEntity.capKind で宣言する。
// 種別との対応は多対一でよく、枠の粒度は種別の粒度と独立に決められる。
export type CapKind = 'bullet' | 'casing' | 'debris' | 'booster';
