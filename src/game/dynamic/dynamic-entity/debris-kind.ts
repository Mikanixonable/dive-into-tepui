// 破片 Entity の構築時に Motion と View へ分配する種別データ。直列化した形を兼ねる。
// accent / size / segment は表示、bornTemperature / bornThermalDeviation / bornSim は
// 物理・寿命判定にだけ使い、各所有者へ必要な値だけを渡す。
export type DebrisKind =
  | { readonly kind: 'fragment'; readonly accent: string | number; readonly size: number; }
  | { readonly kind: 'barrel'; readonly bornTemperature: number; readonly bornThermalDeviation: number; }
  | { readonly kind: 'magazineFrame'; }
  | { readonly kind: 'casing'; readonly bornSim: number; }
  | { readonly kind: 'boosterCover'; readonly segment: number; readonly bornSim: number; }
  | { readonly kind: 'boosterBolt'; readonly segment: number; readonly bornSim: number; };
