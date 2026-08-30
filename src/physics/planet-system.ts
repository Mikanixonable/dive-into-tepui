// 惑星-衛星系。木構造の内側のノードで、系の重心が描く軌道と、その系に属する天体(惑星本体と
// 衛星)を持つ。**重心と惑星本体は別のもの** — 惑星本体は重心から衛星ぶんを差し引いた位置に
// あり、地球なら 4,673 km 離れる。
// 評価の依存はこのノードを根に一方向へ流れる: 重心(軌道だけで決まる)→ 衛星の惑星相対
// (重心の平均角から太陽方向を取る)→ 惑星本体(重心 − 衛星ぶん)→ 衛星の恒星中心。
// THREE/DOM 非依存。
import { PlanetDef, PlanetMotion, SatelliteMotion, StarMotion } from './celestial-motion';
import { KeplerOrbit, keplerOrbitState } from './kepler-orbit';
import { KinematicState, kinematicState } from './kinematic-state';
import { PlanetAngles, planetAngles } from './planet-orbit';

export class PlanetSystem {
  private readonly moons: SatelliteMotion[] = [];
  private planetBody: PlanetMotion | null = null;

  // orbit は系の重心が主星まわりに描く軌道。
  constructor(readonly orbit: KeplerOrbit) {}

  // 系の重心の恒星中心状態。重心の軌道は中心が恒星なので、主天体相対がそのまま恒星中心に
  // なる — 原点の読み替えはここでしか起きない。
  helioStateAt(t: number): KinematicState<'helio'> {
    const s = keplerOrbitState(this.orbit, t);
    return kinematicState<'helio'>(t, s.r, s.v);
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
  return system;
}
