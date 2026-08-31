// 惑星-衛星系。木構造の内側のノードで、系の重心が描く軌道と、その系に属する天体(惑星本体と
// 衛星)を持つ。**重心と惑星本体は別のもの** — 惑星本体は重心から衛星ぶんを差し引いた位置に
// あり、地球なら 4,673 km 離れる。
// 評価の依存はこのノードを根に一方向へ流れる: 重心の主星相対二体解(軌道だけで決まる)→
// 衛星の惑星相対(重心の平均角から太陽方向を取る)→ 重心の太陽系重心位置(主星の畳み込みが
// 配る)→ 惑星本体(重心 − 衛星ぶん)→ 衛星の太陽系重心位置。
// THREE/DOM 非依存。
import { Vec3, addScaled } from '../math/vec3';
import { PointEphemeris, boundStateAt } from './point-ephemeris';
import { PlanetDef, PlanetMotion, SatelliteMotion, StarMotion } from './celestial-motion';
import { KeplerOrbit, keplerOrbitState } from './kepler-orbit';
import {
  KinematicState, addPrimaryRelative, kinematicState, toPrimaryRelative,
} from './kinematic-state';
import { PlanetAngles, planetAngles } from './planet-orbit';
import { satelliteState } from './satellite-orbit';
import { TimeCacheStats, TimeRing, addTimeCacheStats } from './time-ring';

// 系に属する天体1時刻ぶんの位置・速度。**どれも太陽系重心相対**で、惑星本体相対の二体解は
// これを組む途中の一時値として現れるだけ。satellites の並びは addSatellite の登録順。
export type SystemMembers = {
  readonly body: KinematicState<'analytic'>;
  readonly satellites: readonly KinematicState<'analytic'>[];
};

export class PlanetSystem {
  private readonly moons: SatelliteMotion[] = [];
  private readonly analyticCache = new TimeRing<KinematicState<'analytic'>>();
  private readonly membersCache = new TimeRing<SystemMembers>();
  private planetBody: PlanetMotion | null = null;

  // 系の重心を直接収録した高精度暦。収録されていなければ null。
  private baryEphemeris: PointEphemeris | null = null;

  // id は惑星本体と同じ(系と本体は1対1)。暦を id で結ぶのに要る。orbit は系の重心が
  // 主星まわりに描く軌道。
  constructor(readonly id: string, readonly orbit: KeplerOrbit) {}

  // 系の重心の暦を結ぶ。暦が惑星本体のほうを収録している系では null のままになる。
  bindEphemeris(ephemeris: PointEphemeris | null): void {
    this.baryEphemeris = ephemeris;
  }

  // 系の重心を暦が直接収録している範囲での状態。収録外・有効期間外では null。
  ownPackedStateAt(t: number): KinematicState<'packed'> | null {
    return boundStateAt(this.baryEphemeris, t);
  }

  // 系の重心の太陽系重心状態。同じ時刻に複数回引かれるので1度へ畳む。
  analyticStateAt(t: number): KinematicState<'analytic'> {
    const cached = this.analyticCache.get(t);
    if (cached !== undefined) return cached;
    // 主星は自分の重心相対位置を組む過程で質量を持つ系ぶんの二体解を解いており、その通しで
    // 各系の太陽系重心状態を配る。自分がその中にいれば、この呼び出しでキャッシュが埋まる。
    const starState = this.body.star.analyticStateAt(t);
    const filled = this.analyticCache.get(t);
    if (filled !== undefined) return filled;
    // 質量が未測定の系は主星の畳み込みに現れないので、自分で解く。
    return this.analyticCache.put(t, addPrimaryRelative(starState, keplerOrbitState(this.orbit, t)));
  }

  // 主星の畳み込みが解いた二体解から組んだ太陽系重心状態を受け取る。**呼ぶのは
  // StarMotion の畳み込みだけ** — 主星相対の二体解を外へ出さずに配るための口。
  receiveAnalyticState(state: KinematicState<'analytic'>): void {
    this.analyticCache.put(state.t, state);
  }

  // 系に属する天体の太陽系重心状態。重心補正が系の全衛星に依存するので、1体ぶんだけを
  // 引くことはできず、系まるごと1件へ畳む。
  membersAt(t: number): SystemMembers {
    const cached = this.membersCache.get(t);
    if (cached !== undefined) return cached;
    return this.membersCache.put(t, this.computeMembers(t));
  }

  // 衛星 index の太陽系重心状態。index は addSatellite が返した登録順。
  satelliteStateAt(index: number, t: number): KinematicState<'analytic'> {
    return this.membersAt(t).satellites[index]!;
  }

  // 惑星本体相対の位置・速度。太陽系重心相対どうしの引き算で作る — 同じ系の中の引き算なので
  // 桁落ちは効かない(最遠のエリス-ディスノミアでも相対 6e-11)。
  satelliteRelStateAt(index: number, t: number): KinematicState<'primaryRel'> {
    const members = this.membersAt(t);
    return toPrimaryRelative(t, members.satellites[index]!, members.body);
  }

  // 負荷確認ウィンドウが読む、系が持つ時刻キャッシュのヒット/ミス累計。
  get cacheStats(): TimeCacheStats {
    return addTimeCacheStats(this.analyticCache.stats, this.membersCache.stats);
  }

  // 系の重心から、惑星本体ぶんと衛星ぶんへ配る。惑星本体は重心から Σ(μ_衛星/μ_系)·r_衛星
  // (r は惑星本体相対)を差し引いた位置にあり、衛星はその本体へ r を足した位置にある。
  private computeMembers(t: number): SystemMembers {
    const bary = this.analyticStateAt(t);
    const moons = this.moons;
    if (moons.length === 0) return { body: bary, satellites: [] };

    const angles = this.anglesAt(t);
    const rels = moons.map((moon) => satelliteState(moon.def.orbit, angles, t));

    const body = this.bodyFromBarycenter(bary, rels);
    return { body, satellites: rels.map((rel) => addPrimaryRelative(body, rel)) };
  }

  // 重心を分け合う全質量(惑星本体 + 全衛星)に対する各衛星の比で、重心から差し引く量を決める。
  private bodyFromBarycenter(
    bary: KinematicState<'analytic'>, rels: readonly KinematicState<'primaryRel'>[],
  ): KinematicState<'analytic'> {
    const muTotal = this.mu;
    // 位置 − 変位 = 位置。演算の途中は札の落ちた素の Vec3 で、名乗り直すのは kinematicState。
    let r: Vec3 = bary.r;
    let v: Vec3 = bary.v;
    for (let i = 0; i < rels.length; i++) {
      const w = this.moons[i]!.def.mu / muTotal;
      r = addScaled(r, rels[i]!.r, -w);
      v = addScaled(v, rels[i]!.v, -w);
    }
    return kinematicState<'analytic'>(bary.t, r, v);
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

  // 衛星をこの系へ登録し、その登録順(satelliteStateAt に渡す index)を返す。**本体が μ を
  // 持たない系へは登録できない** — 重心を分け合う比が衛星だけで決まって本体の質量比が 0 に
  // なり、本体が衛星との距離ぶんまるごとずれる。衛星の軌道長半径と周期があれば系の μ は
  // ケプラー第3法則で必ず決まるので、この制約はどの系でも満たせる。
  addSatellite(satellite: SatelliteMotion): number {
    if (this.body.def.mu <= 0) {
      throw new Error(`PlanetSystem: μ を持たない ${this.id} へ衛星 ${satellite.def.id} は登録できない`);
    }
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
