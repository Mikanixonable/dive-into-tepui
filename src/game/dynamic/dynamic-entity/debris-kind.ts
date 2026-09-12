// 破片 Entity の構築時に Motion と View へ分配する、保存可能な種別データ。
// accent / size は fragment の表示、bornTemperature / bornThermalDeviation / bornSim は
// 物理・寿命判定にだけ使い、各所有者へ必要な値だけを渡す。
export type DebrisKind =
  | { kind: 'fragment'; accent: string | number; size: number; }
  | { kind: 'barrel'; bornTemperature: number; bornThermalDeviation: number; }
  | { kind: 'magazineFrame'; }
  | { kind: 'casing'; bornSim: number; }
  | { kind: 'boosterCover'; segment: number; bornSim: number; }
  | { kind: 'boosterBolt'; segment: number; bornSim: number; };
