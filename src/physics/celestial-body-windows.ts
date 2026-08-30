// 星系の全天体を、時刻 t での重力源表現(CelestialBody)の配列としてまとめて引く窓。
// **ECI 化はここでしか起きない** — 天体は恒星中心までを答え、ここが ECI 原点天体を時刻ごとに
// 1回だけ引いて差し引く。積分・接触判定・抗力は個体ではなくこの配列に対して回るので、同一 t
// には同一の配列参照を返し(TimeRing でメモ化)、呼び出し側が配列と要素を読み取り専用として
// 扱えるようにする。THREE/DOM 非依存。
import { CelestialBody, celestialBodyStateAt } from './celestial-body';
import { CelestialMotion, OrbitingMotion } from './celestial-motion';
import { KinematicState, toEci } from './kinematic-state';
import { TimeCacheStats, TimeRing, addTimeCacheStats } from './time-ring';
import { Vec3, sub } from '../math/vec3';

// 時刻 t における ECI 原点天体の状態。**2つの経路は原点が違う**(暦パックは太陽系重心中心、
// 解析暦は恒星中心)が、ECI 化はどちらも同じ経路どうしの差なので原点は打ち消える。
// ephemeris が null なら暦パックはこの時刻を答えられないので、全天体が解析経路へ落ちる。
type OriginState = {
  readonly ephemeris: KinematicState<'barycentric'> | null;
  readonly analytic: KinematicState<'helio'>;
  readonly accel: Vec3;
};

export class CelestialBodyWindows {
  // mu が 0 でない天体と、大気を持つ天体の添字(いずれも宣言順)。どちらも時刻に依らないので
  // 構築時に確定する。
  private readonly gravityIndices: readonly number[];
  private readonly atmosphereIndices: readonly number[];
  private readonly indexById: ReadonlyMap<string, number>;

  // 天体ごとの ECI 瞬間値。motions と同じ並び。
  private readonly bodyCaches: readonly TimeRing<CelestialBody>[];
  private readonly originCache = new TimeRing<OriginState>();
  private readonly allCache = new TimeRing<readonly CelestialBody[]>();
  private readonly gravityCache = new TimeRing<readonly CelestialBody[]>();
  private readonly atmosphereCache = new TimeRing<readonly CelestialBody[]>();

  // motions は宣言順の全登録天体(返る配列の順序でもある)、origin は ECI の中心天体。
  constructor(
    private readonly motions: readonly CelestialMotion[],
    private readonly origin: CelestialMotion,
  ) {
    const indices = motions.map((_, i) => i);
    this.gravityIndices = indices.filter((i) => motions[i]!.def.mu !== 0);
    this.atmosphereIndices = indices.filter((i) => {
      const m = motions[i]!;
      return m instanceof OrbitingMotion && m.def.atmosphere !== undefined;
    });
    this.indexById = new Map(motions.map((m, i) => [m.id, i]));
    this.bodyCaches = motions.map(() => new TimeRing<CelestialBody>());
  }

  // 指定時刻の全登録天体(宣言順)。中心天体は原点に静止。
  // 同一 t には同一の配列参照が返るので、**呼び出し側はこの配列と要素を書き換えてはならない。**
  celestialBodiesAt(t: number): readonly CelestialBody[] {
    const cached = this.allCache.get(t);
    if (cached !== undefined) return cached;
    return this.allCache.put(t, this.motions.map((_, i) => this.bodyAtIndex(i, t)));
  }

  // 指定時刻の重力源天体(mu が 0 でないもの、宣言順)。配列の扱いは celestialBodiesAt と同じ。
  gravityAttractorsAt(t: number): readonly CelestialBody[] {
    const cached = this.gravityCache.get(t);
    if (cached !== undefined) return cached;
    return this.gravityCache.put(t, this.gravityIndices.map((i) => this.bodyAtIndex(i, t)));
  }

  // 指定時刻の大気を持つ天体(宣言順)。抗力を掛ける1体を選ぶ側が引く窓で、配列の扱いは
  // celestialBodiesAt と同じ。
  atmosphereCelestialBodiesAt(t: number): readonly CelestialBody[] {
    const cached = this.atmosphereCache.get(t);
    if (cached !== undefined) return cached;
    return this.atmosphereCache.put(t, this.atmosphereIndices.map((i) => this.bodyAtIndex(i, t)));
  }

  // 天体 id の時刻 t での ECI 瞬間値。登録されていない id を渡すと例外になる。
  bodyAt(id: string, t: number): CelestialBody {
    const index = this.indexById.get(id);
    if (index === undefined) throw new Error(`CelestialBodyWindows: 登録されていない天体 id: ${id}`);
    return this.bodyAtIndex(index, t);
  }

  // pivot で厳密に引いた値から時刻 t へ2次で外挿した ECI 位置・速度。t を省くと pivot 自身の
  // 厳密な値。|t − pivot| は積分1歩の幅程度に収め、pivot の種類をむやみに増やさないこと。
  stateAt(id: string, pivot: number, t: number = pivot): KinematicState {
    return celestialBodyStateAt(this.bodyAt(id, pivot), t);
  }

  // celestialBodiesAt の窓だけのヒット/ミス累計。
  get celestialBodiesStats(): TimeCacheStats { return this.allCache.stats; }

  // 全ての時刻キャッシュを合算したヒット/ミス累計。
  get stats(): TimeCacheStats {
    let stats = addTimeCacheStats(this.allCache.stats, this.gravityCache.stats);
    stats = addTimeCacheStats(stats, this.atmosphereCache.stats);
    stats = addTimeCacheStats(stats, this.originCache.stats);
    for (const cache of this.bodyCaches) stats = addTimeCacheStats(stats, cache.stats);
    for (const motion of this.motions) stats = addTimeCacheStats(stats, motion.cacheStats);
    return stats;
  }

  // 天体1体の ECI 瞬間値。**この天体と ECI 原点天体は必ず同じ供給源から引く** — 暦パックと
  // 解析暦は同じ天体に別の位置を答えるので、片方をパック・片方を解析で引くと、その差が
  // そのまま相対位置の誤りになる。原点天体自身は同じ計算を2回引いて厳密に 0 になる。
  // 加速度は供給源が分かれない(暦パックは位置係数しか持たない)ので常に解析。
  private bodyAtIndex(index: number, t: number): CelestialBody {
    const cache = this.bodyCaches[index]!;
    const cached = cache.get(t);
    if (cached !== undefined) return cached;
    const motion = this.motions[index]!;
    const def = motion.def;
    const origin = this.originAt(t);
    // 原点が暦パックで引けない時刻では、この天体も引かずに解析経路へ揃える。
    const originEphemeris = origin.ephemeris;
    const ephemeris = originEphemeris === null ? null : motion.packedStateAt(t);
    return cache.put(t, {
      id: def.id, mu: def.mu, radius: def.radius,
      state: ephemeris === null || originEphemeris === null
        ? toEci(t, motion.helioStateAt(t), origin.analytic)
        : toEci(t, ephemeris, originEphemeris),
      accel: sub(motion.helioAccelAt(t), origin.accel),
      degree2: motion.degree2At(t), atmosphere: motion.atmosphereAt(t),
      isStar: motion.kind === 'star',
    });
  }

  // 時刻 t の ECI 原点天体の恒星中心状態。全天体が同じ時刻で同じ原点を引くので1回へ畳む。
  private originAt(t: number): OriginState {
    const cached = this.originCache.get(t);
    if (cached !== undefined) return cached;
    return this.originCache.put(t, {
      ephemeris: this.origin.packedStateAt(t),
      analytic: this.origin.helioStateAt(t),
      accel: this.origin.helioAccelAt(t),
    });
  }
}
