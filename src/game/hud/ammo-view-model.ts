import type { AmmoTotals } from '../player/gun-magazine';

// 機関砲の弾薬状態。健全な砲の合計に、リロードの残り reloadRemaining [s] と初速の平均
// muzzleVelocityMps [m/s](弾速を持たない操作対象では null)を添える。
export interface AmmoViewModel extends AmmoTotals {
  readonly reloadRemaining: number;
  readonly muzzleVelocityMps: number | null;
}

// 弾薬状態の表記(例: "RELOADING..." / "弾切れ" / "18/40 +2連")。マガジン交換中は装弾数によらず
// リロード表示を優先する。ammo は健全な砲の合計、reloadRemaining はリロードの残り [s]。
export function fmtAmmoStatus(ammo: AmmoTotals, reloadRemaining: number): string {
  if (reloadRemaining > 0) return 'RELOADING...';
  if (ammo.rounds <= 0 && ammo.mags <= 0) return '弾切れ';
  return `${ammo.rounds}/${ammo.capacity} +${ammo.mags}連`;
}

// 手動装填が始められない理由。装填できる場合は null。
export function reloadDisabledReason(ammo: AmmoTotals): string | null {
  if (ammo.rounds <= 0 && ammo.mags <= 0) return '弾切れのため装填できません';
  if (ammo.rounds >= ammo.capacity) return '弾倉は満杯です';
  return null;
}
