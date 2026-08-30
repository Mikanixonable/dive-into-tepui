// 星系の全天体を、時刻 t での重力源表現(CelestialBody)の配列としてまとめて引く窓。値そのものは
// 天体1体ずつが答え、ここは集合を組むだけ。積分・接触判定・抗力は個体ではなくこの配列に対して
// 回るので、同一 t には同一の配列参照を返し(TimeRing でメモ化)、呼び出し側が配列と要素を
// 読み取り専用として扱えるようにする。THREE/DOM 非依存。
import { CelestialBody, celestialBodyStateAt } from './celestial-body';
import { CelestialMotion, OrbitingMotion } from './celestial-motion';
import { KinematicState } from './kinematic-state';
import { TimeCacheStats, TimeRing, addTimeCacheStats } from './time-ring';

export class CelestialBodyWindows {
  // mu が 0 でない天体と、大気を持つ天体(いずれも宣言順)。どちらも時刻に依らないので
  // 構築時に確定する。
  private readonly gravityMotions: readonly CelestialMotion[];
  private readonly atmosphereMotions: readonly CelestialMotion[];
  private readonly motionsById: ReadonlyMap<string, CelestialMotion>;

  private readonly allCache = new TimeRing<readonly CelestialBody[]>();
  private readonly gravityCache = new TimeRing<readonly CelestialBody[]>();
  private readonly atmosphereCache = new TimeRing<readonly CelestialBody[]>();

  // motions は宣言順の全登録天体(返る配列の順序でもある)、origin は ECI の中心天体。
  constructor(
    private readonly motions: readonly CelestialMotion[],
    origin: CelestialMotion,
  ) {
    this.gravityMotions = motions.filter((m) => m.def.mu !== 0);
    this.atmosphereMotions = motions.filter(
      (m) => m instanceof OrbitingMotion && m.def.atmosphere !== undefined,
    );
    this.motionsById = new Map(motions.map((m) => [m.id, m]));
    for (const motion of motions) motion.bindEciOrigin(origin);
  }

  // 指定時刻の全登録天体(宣言順)。中心天体は原点に静止。
  // 同一 t には同一の配列参照が返るので、**呼び出し側はこの配列と要素を書き換えてはならない。**
  celestialBodiesAt(t: number): readonly CelestialBody[] {
    const cached = this.allCache.get(t);
    if (cached !== undefined) return cached;
    return this.allCache.put(t, this.motions.map((m) => m.celestialBodyAt(t)));
  }

  // 指定時刻の重力源天体(mu が 0 でないもの、宣言順)。配列の扱いは celestialBodiesAt と同じ。
  gravityAttractorsAt(t: number): readonly CelestialBody[] {
    const cached = this.gravityCache.get(t);
    if (cached !== undefined) return cached;
    return this.gravityCache.put(t, this.gravityMotions.map((m) => m.celestialBodyAt(t)));
  }

  // 指定時刻の大気を持つ天体(宣言順)。抗力を掛ける1体を選ぶ側が引く窓で、配列の扱いは
  // celestialBodiesAt と同じ。
  atmosphereCelestialBodiesAt(t: number): readonly CelestialBody[] {
    const cached = this.atmosphereCache.get(t);
    if (cached !== undefined) return cached;
    return this.atmosphereCache.put(t, this.atmosphereMotions.map((m) => m.celestialBodyAt(t)));
  }

  // 天体 id の時刻 t での ECI 瞬間値。登録されていない id を渡すと例外になる。
  bodyAt(id: string, t: number): CelestialBody {
    const motion = this.motionsById.get(id);
    if (motion === undefined) throw new Error(`CelestialBodyWindows: 登録されていない天体 id: ${id}`);
    return motion.celestialBodyAt(t);
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
    for (const motion of this.motions) stats = addTimeCacheStats(stats, motion.cacheStats);
    return stats;
  }
}
