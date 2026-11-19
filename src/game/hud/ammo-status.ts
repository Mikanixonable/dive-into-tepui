import { MAG_ROUNDS } from '../player/ammo-spec';

// 機関砲の弾薬状態。muzzleVelocityMps は初速の平均 [m/s] で、
// 弾速を持たない操作対象では null。
export interface AmmoViewModel {
  readonly rounds: number;
  readonly mags: number;
  readonly cooldown: number;
  readonly muzzleVelocityMps: number | null;
}

// 弾薬状態の表記(例: "RELOADING..." / "弾切れ" / "18/32 +2連")。バレル交換中は
// 装弾数によらずリロード表示を優先する。
export function fmtAmmoStatus(roundsInMag: number, magsLeft: number, reloadTimer: number): string {
  if (reloadTimer > 0) return 'RELOADING...';
  if (roundsInMag <= 0 && magsLeft <= 0) return '弾切れ';
  return `${roundsInMag}/${MAG_ROUNDS} +${magsLeft}連`;
}
