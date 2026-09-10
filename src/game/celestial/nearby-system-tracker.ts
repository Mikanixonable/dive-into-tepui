// カメラがいまどの系にいるかを、フレームをまたいでぶれないように答える。
// strongestAttractor をそのまま判定に使うと、勢力圏が極端に狭い天体(主星から極端に近い衛星など)
// ではフレームごとの浮動小数点誤差やカメラの微小な移動だけで最強天体が入れ替わり、系のラベルが
// 明滅する(MAP.md 4節)。直前フレームの勝者を STICKY_MARGIN_SQ 倍まで有利に扱い、新しい候補が
// 明確に優勢でない限り系を切り替えない。**per-frame で呼ぶ側がインスタンスを保持して使うこと。**
import { attractorAccel, strongestAttractor } from '../../physics/attractor';
import { Vec3, lenSq } from '../../math/vec3';
import type { CelestialBodies } from './celestial-bodies';

// 直前フレームの勝者を優遇する倍率(加速度の二乗で比べるので二乗値で持つ)。
export const STICKY_MARGIN_SQ = 1.2 * 1.2;

export class NearbySystemTracker {
  private previousId: string | null = null;

  // 直前フレームの勝者を優遇したうえでの CelestialBodies.systemChainAt。
  private chainAt(celestialBodies: CelestialBodies, cameraPos: Vec3, pivot: number): readonly string[] {
    if (celestialBodies.celestialMotions.length === 0) return [];
    const nearest = this.pickNearest(celestialBodies, cameraPos, pivot);
    this.previousId = nearest;
    return celestialBodies.chainFrom(nearest);
  }

  // 直前フレームの勝者を優遇したうえでの CelestialBodies.systemMembersAt。
  membersAt(celestialBodies: CelestialBodies, cameraPos: Vec3, pivot: number): readonly string[] {
    return celestialBodies.membersFrom(this.chainAt(celestialBodies, cameraPos, pivot));
  }

  // 最も強く引く天体の id。直前フレームの勝者は STICKY_MARGIN_SQ 倍まで有利に扱う。
  private pickNearest(celestialBodies: CelestialBodies, cameraPos: Vec3, pivot: number): string {
    const best = strongestAttractor(cameraPos, celestialBodies.celestialMotions, pivot);
    if (this.previousId === null || this.previousId === best.id) return best.id;
    const previous = celestialBodies.findMotion(this.previousId);
    if (previous === null) return best.id;
    const bestAccel = lenSq(attractorAccel(cameraPos, best, pivot));
    const prevAccel = lenSq(attractorAccel(cameraPos, previous, pivot));
    return bestAccel > prevAccel * STICKY_MARGIN_SQ ? best.id : previous.id;
  }
}
