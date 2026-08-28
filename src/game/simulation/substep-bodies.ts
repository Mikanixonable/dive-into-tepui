// 1サブステップぶんの天体の窓。重力源・表面/遮蔽体・大気天体を、その区間の中で1組だけ組む。
// 「どの天体が引くか」「どの大気が抗力を及ぼすか」という個体ごとの絞り込みも、この1組の上で
// 答える — 分類を多数の問い合わせ位置で使い回すことが、絞り込みが得になる条件そのものだから。
import {
  CelestialBody, nearestAtmosphereBody,
} from '../../physics/celestial-body';
import type { Ephemeris } from '../../physics/ephemeris';
import { Vec3 } from '../../math/vec3';
import { ClassifiedAttractors, attractorsNearInto, classifyAttractors } from './attractors';

export class SubstepBodies {
  private classified: ClassifiedAttractors = classifyAttractors([]);
  private _gravitySourceCount = 0;
  private _surface: readonly CelestialBody[] = [];
  private _atmosphere: readonly CelestialBody[] = [];
  private _star: CelestialBody | null = null;
  private readonly nearScratch: CelestialBody[] = [];

  // 区間 [simTime, simTime + dt] の窓を組み直す。重力源と大気は区間の中点で解決し、表面と
  // 遮蔽体は開始時刻で解決する — 遮蔽の幾何は区間内の天体の移動にほとんど左右されず、
  // 表面の側は接触の解決が各個体の時刻へ引き直すため。
  reset(ephemeris: Ephemeris, simTime: number, dt: number): void {
    const mid = simTime + dt / 2;
    const sources = ephemeris.gravityAttractorsAt(mid);
    this._gravitySourceCount = sources.length;
    this.classified = classifyAttractors(sources);
    this._surface = ephemeris.celestialBodiesAt(simTime);
    this._atmosphere = ephemeris.atmosphereCelestialBodiesAt(mid);
    this._star = this._surface.find((b) => b.isStar) ?? null;
  }

  // 表面を持ち、かつ太陽を隠しうる相手。半径と位置の幾何だけで決まるので、登録天体の全数。
  get surface(): readonly CelestialBody[] { return this._surface; }

  // 大気を持つ天体の全数。抗力を及ぼす1体は個体ごとに選ぶ。
  get atmosphere(): readonly CelestialBody[] { return this._atmosphere; }

  // 日照と受熱の光源になる恒星。無ければ null。
  get star(): CelestialBody | null { return this._star; }

  // この区間の重力源の本数。
  get gravitySourceCount(): number { return this._gravitySourceCount; }

  // 位置 r へ効く重力源。返る配列は次の呼び出しで上書きされるので、その場で使い切る。
  attractorsNear(r: Vec3): readonly CelestialBody[] {
    return attractorsNearInto(r, this.classified, this.nearScratch);
  }

  // 位置 r に抗力を及ぼすただ1体の大気天体。無ければ null。
  atmosphereBodyNear(r: Vec3): CelestialBody | null {
    return nearestAtmosphereBody(r, this._atmosphere);
  }
}
