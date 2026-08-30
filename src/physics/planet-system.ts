// 惑星-衛星系。木構造の内側のノードで、系の重心が描く軌道と、その系に属する天体(惑星本体と
// 衛星)を持つ。**重心と惑星本体は別のもの** — 惑星本体は重心から衛星ぶんを差し引いた位置に
// あり、地球なら 4,673 km 離れる。
// 評価の依存はこのノードを根に一方向へ流れる: 重心の主星相対(軌道だけで決まる)→ 衛星の
// 惑星相対(重心の平均角から太陽方向を取る)→ 重心の太陽系重心位置(主星の重心相対位置を
// 足す)→ 惑星本体(重心 − 衛星ぶん)→ 衛星の太陽系重心位置。
// THREE/DOM 非依存。
import { PlanetDef, PlanetMotion, SatelliteMotion, StarMotion } from './celestial-motion';
import { KeplerOrbit, keplerOrbitState } from './kepler-orbit';
import { KinematicState, addPrimaryRelative, kinematicState } from './kinematic-state';
import { PlanetAngles, planetAngles } from './planet-orbit';
import { TimeCacheStats, TimeRing } from './time-ring';

export class PlanetSystem {
  private readonly moons: SatelliteMotion[] = [];
  private readonly starRelCache = new TimeRing<KinematicState<'primaryRel'>>();
  private planetBody: PlanetMotion | null = null;

  // orbit は系の重心が主星まわりに描く軌道。
  constructor(readonly orbit: KeplerOrbit) {}

  // 系の重心の主星相対状態。重心の軌道は中心が主星なので、二体解がそのまま主星相対になる。
  // **主星の位置を経由しない**ので、主星がこれを集めて自分の重心相対位置を組んでも循環しない。
  // 同じ時刻に複数回引かれるので1度へ畳む。
  starRelStateAt(t: number): KinematicState<'primaryRel'> {
    const cached = this.starRelCache.get(t);
    if (cached !== undefined) return cached;
    const s = keplerOrbitState(this.orbit, t);
    return this.starRelCache.put(t, kinematicState<'primaryRel'>(t, s.r, s.v));
  }

  // 系の重心の太陽系重心状態。主星の重心相対位置に、主星相対の二体解を足す。
  analyticStateAt(t: number): KinematicState<'analytic'> {
    const star = this.body.star;
    const rel = this.starRelStateAt(t);
    // 主星を持たない星系では、二体解の中心がそのまま原点。
    if (star === null) return kinematicState<'analytic'>(t, rel.r, rel.v);
    return addPrimaryRelative(star.analyticStateAt(t), rel);
  }

  // 負荷確認ウィンドウが読む、主星相対の二体解の時刻キャッシュのヒット/ミス累計。
  get cacheStats(): TimeCacheStats { return this.starRelCache.stats; }

  // この系が重心を分け合う全質量(惑星本体 + 全衛星)。衛星は構築のたびに増えるので、
  // 構築時に畳まず引かれた時点で合算する。
  get mu(): number {
    let total = this.body.def.mu;
    for (const moon of this.moons) total += moon.def.mu;
    return total;
  }

  // 衛星モデルが太陽方向を求めるのに要る平均角。重心の軌道から取るので惑星本体の位置に
  // 依存しない — 依存させると惑星本体の評価と相互再帰になる。
  anglesAt(t: number): PlanetAngles {
    return planetAngles(this.orbit, t);
  }

  // この系の惑星本体。setBody より前に読むと例外。
  get body(): PlanetMotion {
    if (this.planetBody === null) throw new Error('PlanetSystem: 惑星本体が設定される前に参照された');
    return this.planetBody;
  }

  // この系の衛星(登録順)。重心補正の対象でもある。
  get satellites(): readonly SatelliteMotion[] {
    return this.moons;
  }

  // 惑星本体を決める。2度目の呼び出しは例外。
  setBody(body: PlanetMotion): void {
    if (this.planetBody !== null) {
      throw new Error(`PlanetSystem: 惑星本体は1度だけ設定できる(${this.planetBody.id} → ${body.id})`);
    }
    this.planetBody = body;
  }

  // 衛星をこの系へ登録する。
  addSatellite(satellite: SatelliteMotion): void {
    this.moons.push(satellite);
  }
}

// 惑星本体と、その系の重心をまとめて組む。衛星を持つ系では、返った PlanetSystem をそのまま
// 衛星へ渡す。star は主星(恒星を持たない星系では null)、spinPhase0 は自転の初期位相 [rad]。
export function planetSystem(
  def: PlanetDef, star: StarMotion | null, spinPhase0 = 0,
): PlanetSystem {
  const system = new PlanetSystem(def.orbit);
  system.setBody(new PlanetMotion(def, star, system, spinPhase0));
  // 主星の重心相対位置にはこの系ぶんの質量と位置が要るので、作った時点で登録する。
  star?.addPlanetSystem(system);
  return system;
}
