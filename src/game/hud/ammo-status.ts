// 弾薬状態の表記。
import { MAG_ROUNDS } from '../player/player-fire';

// 弾薬状態の表記(例: "RELOADING..." / "弾切れ" / "18/32 +2連")。バレル交換中は
// 装弾数によらずリロード表示を優先する。
export function fmtAmmoStatus(roundsInMag: number, magsLeft: number, reloadTimer: number): string {
  if (reloadTimer > 0) return 'RELOADING...';
  if (roundsInMag <= 0 && magsLeft <= 0) return '弾切れ';
  return `${roundsInMag}/${MAG_ROUNDS} +${magsLeft}連`;
}
