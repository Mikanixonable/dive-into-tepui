// 破片の種別と、種別ごとの値。直列化した形を兼ねる。accent / size / segment は見た目を、
// bornTemperature / bornThermalDeviation / bornSim は熱と寿命を決める。
export type DebrisKind =
  | { readonly kind: 'fragment'; readonly accent: string | number; readonly size: number; }
  | { readonly kind: 'barrel'; readonly bornTemperature: number; readonly bornThermalDeviation: number; }
  | { readonly kind: 'magazineFrame'; }
  | { readonly kind: 'casing'; readonly bornSim: number; }
  | { readonly kind: 'boosterCover'; readonly segment: number; readonly bornSim: number; }
  | { readonly kind: 'boosterBolt'; readonly segment: number; readonly bornSim: number; };
