// 天体の暦の値を ECI(原点に置いた1体を中心とする座標)へ移す平行移動。軸は変わらないので
// 回転は起きず、時刻を持ったまま KinematicState として出る。
// **供給源を揃える不変条件をここが負う** — 暦パックと解析暦は同じ天体に別の位置を答えるので、
// 片方をパック・片方を解析で引くと、その差がそのまま相対位置の誤りになる。原点が暦パックで
// 引ける時刻だけ両者をパックで引き、それ以外は両者を解析へ揃える。
// THREE/DOM 非依存。
import type { CelestialMotion } from './celestial-motion';
import { KinematicState, toEci } from './kinematic-state';
import { TimeCacheStats, TimeRing } from './time-ring';
import { Vec3, sub } from '../math/vec3';

// ECI 原点天体が時刻 t に答える、原点を引くための一式。どちらも太陽系重心中心だが、
// **供給源が違えば同じ天体に別の位置を答える**ので、ECI 化は必ず同じ経路どうしで差を取る。
// ephemeris が null の時刻は、全天体が解析経路へ落ちる。
type OriginState = {
  readonly ephemeris: KinematicState<'packed'> | null;
  readonly analytic: KinematicState<'analytic'>;
  readonly accel: Vec3;
};

export class EciTransform {
  // 全天体が同じ時刻で同じ原点を引くので、原点1体ぶんの一式は1回へ畳む。
  private readonly originCache = new TimeRing<OriginState>();

  // origin は ECI 原点に置く天体。原点天体自身も同じ計算を2回引くので、位置は厳密に 0 になる。
  constructor(private readonly origin: CelestialMotion) {}

  // ECI 原点に置いている天体の id。
  get originId(): string { return this.origin.id; }

  // 時刻 t の ECI 位置・速度。
  stateAt(t: number, motion: CelestialMotion): KinematicState {
    return this.translate(t, motion, this.originStateAt(t));
  }

  // 時刻 t の ECI 加速度。供給源が分かれない(暦パックは位置係数しか持たない)ので常に解析。
  accelAt(t: number, motion: CelestialMotion): Vec3 {
    return sub(motion.analyticAccelAt(t), this.originStateAt(t).accel);
  }

  // 負荷確認ウィンドウが読む、原点一式の時刻キャッシュのヒット/ミス累計。
  get cacheStats(): TimeCacheStats { return this.originCache.stats; }

  // 引いた原点一式のもとで平行移動する。原点が暦パックで引けない時刻では、この天体も
  // 引かずに解析経路へ揃える。
  private translate(t: number, motion: CelestialMotion, origin: OriginState): KinematicState {
    const originEphemeris = origin.ephemeris;
    const ephemeris = originEphemeris === null ? null : motion.packedStateAt(t);
    return ephemeris === null || originEphemeris === null
      ? toEci(t, motion.analyticStateAt(t), origin.analytic)
      : toEci(t, ephemeris, originEphemeris);
  }

  // ECI 原点天体の一式。同じ時刻で全天体から引かれるので1回へ畳む。
  private originStateAt(t: number): OriginState {
    const cached = this.originCache.get(t);
    if (cached !== undefined) return cached;
    return this.originCache.put(t, {
      ephemeris: this.origin.packedStateAt(t),
      analytic: this.origin.analyticStateAt(t),
      accel: this.origin.analyticAccelAt(t),
    });
  }
}
