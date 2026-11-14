// ストーリーモードの敵の意図(COMBAT.md「AI と射撃」)。標的との距離と、その距離が
// 縮んでいるか広がっているかから決まる4状態で、遷移はこのモジュールの純関数が持つ。
// 敵は弾道で飛ぶため、意図は操舵ではなく「いま何をしようとしているか」の読みであり、
// 射撃は射撃姿勢の間だけ行われる。
import { ENGAGEMENT_RANGE } from '../engagement-zone';

// 敵の意図。接近 → 射撃姿勢 → 離脱 → 再会合の順に巡る。
export type EnemyIntent = 'approach' | 'firing-posture' | 'departure' | 'rendezvous';

// 接近と再会合を分ける距離 [m]。交戦圏より遠くでは、近づいていてもまず再会合と読む。
export const ENEMY_INTENT_RENDEZVOUS_RANGE = ENGAGEMENT_RANGE * 4;

// 意図を持ち始めた敵の最初の意図。遠方から会合へ向かう途上として読む。
export const ENEMY_INTENT_INITIAL: EnemyIntent = 'rendezvous';

// 距離 distance [m] と距離の変化率 radialRate [m/s](縮んでいれば負)から、現在の意図
// current の次の意図を決める。交戦圏の内側では、離れていく敵だけが離脱で、それ以外は
// 射撃姿勢。圏外では、縮んでいても再会合の距離より遠ければ再会合のままにする。
export function nextEnemyIntent(
  current: EnemyIntent, distance: number, radialRate: number,
): EnemyIntent {
  if (distance <= ENGAGEMENT_RANGE) {
    return radialRate > 0 ? 'departure' : 'firing-posture';
  }
  if (radialRate < 0) {
    if (distance <= ENEMY_INTENT_RENDEZVOUS_RANGE) return 'approach';
    return current === 'approach' ? 'approach' : 'rendezvous';
  }
  return 'rendezvous';
}

// その意図の間、射撃してよいか。射撃姿勢の間だけ撃つ。
export function enemyIntentAllowsFire(intent: EnemyIntent): boolean {
  return intent === 'firing-posture';
}
