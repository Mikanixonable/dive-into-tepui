// 惑星-衛星系。木構造の内側のノードで、系の重心が描く軌道と、その系に属する天体(惑星本体と
// 衛星)を持つ。**重心と惑星本体は別のもの** — 惑星本体は重心から衛星ぶんを差し引いた位置に
// あり、地球なら 4,673 km 離れる。
// 評価の依存はこのノードを根に一方向へ流れる: 重心の主星相対二体解(軌道だけで決まる)→
// 衛星の惑星相対(重心の平均角から太陽方向を取る)→ 惑星本体(重心 − 衛星ぶん)→ 衛星の主星相対。
// 太陽系重心相対はどれも「主星の重心相対位置 + 主星相対」で導く。
//
// **採用した近似**: 惑星本体を組む重心補正 Σ に、本体を動かさない衛星を入れない
// (NEGLIGIBLE_BODY_OFFSET)。落とす変位の合計はその定数以下で、系の天体はまとめてその量だけ
// 主星に対してずれる。**系の内側の相対幾何は動かない** — 衛星も同じ本体から組むため。
// THREE/DOM 非依存。
import { Vec3, addScaled, v3 } from '../math/vec3';
import { PointEphemeris, boundBaryStateAt } from './ephemeris/point';
import { PlanetDef, PlanetMotion, SatelliteMotion, StarMotion } from './celestial-motion';
import { KeplerOrbit, keplerOrbitAccel, keplerOrbitState } from './kepler-orbit';
import {
  KinematicState, addPrimaryRelative, fromStarRelative, kinematicState,
} from './kinematic-state';
import { PlanetAngles, planetAngles } from './kepler-orbit';
import { SatelliteOrbit, satelliteState } from './satellite-orbit';
import { TimeCacheStats, TimeRing, addTimeCacheStats } from './time-ring';

// 惑星本体の位置を組むとき、重心補正から落としてよい変位の合計 [m]。衛星の惑星相対軌道は
// 平均要素の二体解へ周期補正項を重ねたモデルで、真値との差は km の桁ある(satellite-orbit.ts
// の到達精度)。ここで落とす量はその 1/1000 未満で、最小の登録天体の半径 245 m にも届かない。
// 0 にすると全衛星が補正に入り、落とすことによる差は無くなる。
export const NEGLIGIBLE_BODY_OFFSET = 1;

// 衛星が惑星本体から離れうる距離の上限 [m]。二体部分の遠点に動径補正項の振幅和を足したもので、
// 周期項は動径へ加算で重なるだけなのでこれを超えない。
function maxPrimaryDistance(orbit: SatelliteOrbit): number {
  let dist = orbit.kepler.a * (1 + orbit.kepler.e);
  for (const term of orbit.distTerms) dist += Math.abs(term.amp);
  return dist;
}

// 系に属する天体1時刻ぶん。body は主星相対、rels は惑星本体相対で、**引かれた衛星だけが
// 埋まる作業表**(並びは addSatellite の登録順)。重心補正に入る衛星は body を組む時点で埋まる。
type SystemMembers = {
  readonly body: KinematicState<'starRel'>;
  readonly angles: PlanetAngles;
  readonly rels: (KinematicState<'primaryRel'> | undefined)[];
};

export class PlanetSystem {
  private readonly moons: SatelliteMotion[] = [];
  private readonly starRelCache = new TimeRing<KinematicState<'starRel'>>();
  private readonly membersCache = new TimeRing<SystemMembers>();
  private planetBody: PlanetMotion | null = null;
  // 重心補正に入れる衛星の登録順。衛星が増えるたびに組み直す。
  private offsetting: readonly number[] | null = null;

  // 系の重心を直接収録した数値暦。収録されていなければ null。
  private baryEphemeris: PointEphemeris | null = null;

  // id は惑星本体と同じ(系と本体は1対1)。暦を id で結ぶのに要る。orbit は系の重心が
  // 主星まわりに描く軌道。
  constructor(readonly id: string, readonly orbit: KeplerOrbit) {}

  // 系の重心の暦を結ぶ。暦が惑星本体のほうを収録している系では null のままになる。
  bindEphemeris(ephemeris: PointEphemeris | null): void {
    this.baryEphemeris = ephemeris;
  }

  // 系の重心を暦が直接収録している範囲での状態。収録外・有効期間外では null。
  ownNumericStateAt(t: number): KinematicState<'numeric'> | null {
    return boundBaryStateAt(this.baryEphemeris, t);
  }

  // 系の重心の主星相対状態。軌道だけで決まる二体解で、同じ時刻に複数回引かれるので1度へ畳む。
  starRelStateAt(t: number): KinematicState<'starRel'> {
    const cached = this.starRelCache.get(t);
    if (cached !== undefined) return cached;
    // 惑星の軌道が乗っているのは主星なので、この二体解の中心は主星そのもの。
    const rel = keplerOrbitState(this.orbit, t);
    return this.starRelCache.put(t, kinematicState<'starRel'>(t, rel.r, rel.v));
  }

  // 系の重心の太陽系重心状態。
  analyticStateAt(t: number): KinematicState<'analytic'> {
    return fromStarRelative(this.body.star.analyticStateAt(t), this.starRelStateAt(t));
  }

  // 系に属する天体の主星相対状態。重心補正が系の全衛星に依存するので、1体ぶんだけを
  // 引くことはできず、系まるごと1件へ畳む。
  membersAt(t: number): SystemMembers {
    const cached = this.membersCache.get(t);
    if (cached !== undefined) return cached;
    return this.membersCache.put(t, this.computeMembers(t));
  }

  // 衛星 index の主星相対状態。index は addSatellite が返した登録順。
  satelliteStarRelStateAt(index: number, t: number): KinematicState<'starRel'> {
    const members = this.membersAt(t);
    return addPrimaryRelative(members.body, this.relFrom(members, index, t));
  }

  // 衛星 index の惑星本体相対の位置・速度。
  satelliteRelStateAt(index: number, t: number): KinematicState<'primaryRel'> {
    return this.relFrom(this.membersAt(t), index, t);
  }

  // 惑星本体が衛星から受ける加速度。位置の重心補正 −Σ w_i·ρ_i の 2 階微分そのもので、
  // **顔ぶれは補正と同じ** — 位置と加速度で入れる衛星がずれると、2 次外挿が位置モデルから外れる。
  bodyAccelFromSatellitesAt(t: number): Vec3 {
    const members = this.membersAt(t);
    const muTotal = this.mu;
    let accel: Vec3 = v3();
    // 符号は位置と同じ −w_i。本体は重心の反対側へ振れるので、加速度は衛星の側を向く。
    for (const index of this.offsettingMoons) {
      const moon = this.moons[index]!;
      const rel = this.relFrom(members, index, t);
      accel = addScaled(
        accel, keplerOrbitAccel(moon.def.orbit.kepler, t, rel.r), -moon.def.mu / muTotal);
    }
    return accel;
  }

  // 負荷確認ウィンドウが読む、系が持つ時刻キャッシュのヒット/ミス累計。
  get cacheStats(): TimeCacheStats {
    return addTimeCacheStats(this.starRelCache.stats, this.membersCache.stats);
  }

  // 系の重心から惑星本体を組む。惑星本体は重心から Σ(μ_衛星/μ_系)·r_衛星(r は惑星本体相対)を
  // 差し引いた位置にあり、衛星はその本体へ r を足した位置にある。Σ に入るのは重心を
  // NEGLIGIBLE_BODY_OFFSET 以上動かす衛星だけで、残りの r は引かれたときに rels へ埋まる。
  private computeMembers(t: number): SystemMembers {
    const bary = this.starRelStateAt(t);
    const angles = this.anglesAt(t);
    const rels: (KinematicState<'primaryRel'> | undefined)[] = new Array(this.moons.length);
    const muTotal = this.mu;
    // 位置 − 変位 = 位置。演算の途中は札の落ちた素の Vec3 で、名乗り直すのは kinematicState。
    let r: Vec3 = bary.r;
    let v: Vec3 = bary.v;
    for (const index of this.offsettingMoons) {
      const moon = this.moons[index]!;
      const rel = satelliteState(moon.def.orbit, angles, t);
      rels[index] = rel;
      const w = moon.def.mu / muTotal;
      r = addScaled(r, rel.r, -w);
      v = addScaled(v, rel.v, -w);
    }
    return { body: kinematicState<'starRel'>(t, r, v), angles, rels };
  }

  // 衛星 index の惑星本体相対状態を作業表から引く。まだ無ければ解いて埋める。
  private relFrom(
    members: SystemMembers, index: number, t: number,
  ): KinematicState<'primaryRel'> {
    const cached = members.rels[index];
    if (cached !== undefined) return cached;
    const rel = satelliteState(this.moons[index]!.def.orbit, members.angles, t);
    members.rels[index] = rel;
    return rel;
  }

  // 重心補正に入れる衛星の登録順。「その衛星が本体を動かす量の上限 w_i·max|r_i|」の小さい順に、
  // 落とす合計が NEGLIGIBLE_BODY_OFFSET に収まる範囲まで落とす。
  private get offsettingMoons(): readonly number[] {
    const cached = this.offsetting;
    if (cached !== null) return cached;
    const muTotal = this.mu;
    const bounds = this.moons.map((moon, index) => ({
      index, offset: (moon.def.mu / muTotal) * maxPrimaryDistance(moon.def.orbit),
    }));
    // 落とす順は上限の小さい側から。合計で測るので、個々が定数を下回るだけでは足りない。
    bounds.sort((a, b) => a.offset - b.offset);
    let dropped = 0;
    let kept = 0;
    while (kept < bounds.length && dropped + bounds[kept]!.offset <= NEGLIGIBLE_BODY_OFFSET) {
      dropped += bounds[kept]!.offset;
      kept++;
    }
    const offsetting = bounds.slice(kept).map((b) => b.index).sort((a, b) => a - b);
    this.offsetting = offsetting;
    return offsetting;
  }

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

  // 衛星をこの系へ登録し、その登録順(satelliteStarRelStateAt に渡す index)を返す。**本体が μ を
  // 持たない系へは登録できない** — 重心を分け合う比が衛星だけで決まって本体の質量比が 0 に
  // なり、本体が衛星との距離ぶんまるごとずれる。衛星の軌道長半径と周期があれば系の μ は
  // ケプラー第3法則で必ず決まるので、この制約はどの系でも満たせる。
  addSatellite(satellite: SatelliteMotion): number {
    if (this.body.def.mu <= 0) {
      throw new Error(`PlanetSystem: μ を持たない ${this.id} へ衛星 ${satellite.def.id} は登録できない`);
    }
    this.offsetting = null;
    return this.moons.push(satellite) - 1;
  }
}

// 惑星本体と、その系の重心をまとめて組む。衛星を持つ系では、返った PlanetSystem をそのまま
// 衛星へ渡す。star は主星、spinPhase0 は自転の初期位相 [rad]。
export function planetSystem(
  def: PlanetDef, star: StarMotion, spinPhase0 = 0,
): PlanetSystem {
  const system = new PlanetSystem(def.id, def.orbit);
  system.setBody(new PlanetMotion(def, star, system, spinPhase0));
  // 主星の重心相対位置にはこの系ぶんの質量と位置が要るので、作った時点で登録する。
  star.addPlanetSystem(system);
  return system;
}
