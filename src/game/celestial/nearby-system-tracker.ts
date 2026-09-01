// カメラがいまどの系にいるかを、フレームをまたいでぶれないように答える。
// strongestAttractor をそのまま判定に使うと、勢力圏が極端に狭い天体(主星から極端に近い衛星など)
// ではフレームごとの浮動小数点誤差やカメラの微小な移動だけで最強天体が入れ替わり、系のラベルが
// 明滅する(MAP.md 4節)。直前フレームの勝者を STICKY_MARGIN_SQ 倍まで有利に扱い、新しい候補が
// 明確に優勢でない限り系を切り替えない。**per-frame で呼ぶ側がインスタンスを保持して使うこと。**
import { attractorAccel, strongestAttractor } from '../../physics/attractor';
import { Vec3, lenSq } from '../../math/vec3';
import type { CelestialSystem } from './celestial-system';

// 直前フレームの勝者を優遇する倍率(加速度の二乗で比べるので二乗値で持つ)。
const STICKY_MARGIN_SQ = 1.2 * 1.2;

export class NearbySystemTracker {
  private previousId: string | null = null;

  // 直前フレームの勝者を優遇したうえでの CelestialSystem.systemChainAt。
  chainAt(celestialSystem: CelestialSystem, cameraPos: Vec3, pivot: number): readonly string[] {
    if (celestialSystem.entities.length === 0) return [];
    const nearest = this.pickNearest(celestialSystem, cameraPos, pivot);
    this.previousId = nearest;
    return celestialSystem.chainFrom(nearest);
  }

  // 直前フレームの勝者を優遇したうえでの CelestialSystem.systemMembersAt。
  membersAt(celestialSystem: CelestialSystem, cameraPos: Vec3, pivot: number): readonly string[] {
    return celestialSystem.membersFrom(this.chainAt(celestialSystem, cameraPos, pivot));
  }

  // 最も強く引く天体の id。直前フレームの勝者は STICKY_MARGIN_SQ 倍まで有利に扱う。
  private pickNearest(celestialSystem: CelestialSystem, cameraPos: Vec3, pivot: number): string {
    const best = strongestAttractor(cameraPos, celestialSystem.celestialMotions, pivot);
    if (this.previousId === null || this.previousId === best.id) return best.id;
    const previous = celestialSystem.find(this.previousId)?.motion;
    if (previous === undefined) return best.id;
    const bestAccel = lenSq(attractorAccel(cameraPos, best, pivot));
    const prevAccel = lenSq(attractorAccel(cameraPos, previous, pivot));
    return bestAccel > prevAccel * STICKY_MARGIN_SQ ? best.id : previous.id;
  }
}
