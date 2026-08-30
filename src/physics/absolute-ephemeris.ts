// 時刻付きの太陽系重心状態を供給する層と、ゲームが使う中心天体基準へ落とす層。
// 暦データの表現(Chebyshev/SPK/テスト用解析解)と座標原点の選択を分離する。
import { KinematicState, kinematicState } from './kinematic-state';
import { Vec3, sub, v3 } from '../math/vec3';

export type BarycentricState = {
  readonly r: Vec3; // ICRF/J2000 [m]
  readonly v: Vec3; // ICRF/J2000 [m/s]
};

export interface AbsoluteEphemeris {
  readonly validStartJdTdb: number;
  readonly validEndJdTdb: number;
  hasBody(id: string): boolean;
  barycentricStateOf(id: string, jdTdb: number): BarycentricState;
}

export class MissingEphemerisBodyError extends Error {
  constructor(readonly bodyId: string) {
    super(`天体暦に天体 ${bodyId} が含まれていない`);
    this.name = 'MissingEphemerisBodyError';
  }
}

// ICRF の (X,Y,Z)=(春分点方向, 赤道面内, 北極) を、ゲームの
// (X,Y,Z)=(春分点方向, 北極, -赤道面内) へ右手系のまま写す。
export function icrfToGameEci(a: Vec3): Vec3 {
  return v3(a.x, a.z, a.y === 0 ? 0 : -a.y);
}

// 恒星(系の階層の根)を中心に、ゲーム ECI 軸で答える暦。**ECI 原点天体を引くのは呼び出し側の
// 仕事** — 解析暦も同じ恒星中心を返すので、どちらの供給源から引いても同じ形の答えになる。
export class HelioEphemeris {
  // 直前に引いた時刻の恒星の状態。1時刻ぶんの ECI 化では全天体が同じ jdTdb でこれを引くので、
  // 1段だけ憶えれば天体数ぶんの Chebyshev 評価が1回に畳まれる。
  private lastStarJdTdb = NaN;
  private lastStarState: BarycentricState | null = null;

  constructor(
    private readonly absolute: AbsoluteEphemeris,
    readonly starId: string,
    readonly epochJdTdb: number,
  ) {
    if (!absolute.hasBody(starId)) throw new MissingEphemerisBodyError(starId);
  }

  hasBody(id: string): boolean {
    return this.absolute.hasBody(id);
  }

  // simTime に対応する jdTdb が absolute の有効期間内かどうか。
  isValidAt(simTime: number): boolean {
    const jdTdb = this.epochJdTdb + simTime / 86400;
    return jdTdb >= this.absolute.validStartJdTdb && jdTdb <= this.absolute.validEndJdTdb;
  }

  // 天体 id の、恒星中心・ゲーム ECI 軸の状態。収録されていない天体は例外を投げる。
  stateOf(id: string, simTime: number): KinematicState<'helio'> {
    if (!this.absolute.hasBody(id)) throw new MissingEphemerisBodyError(id);
    const jdTdb = this.epochJdTdb + simTime / 86400;
    const body = this.absolute.barycentricStateOf(id, jdTdb);
    const star = this.starStateAt(jdTdb);
    return kinematicState<'helio'>(
      simTime,
      icrfToGameEci(sub(body.r, star.r)),
      icrfToGameEci(sub(body.v, star.v)),
    );
  }

  // 時刻 jdTdb の恒星の重心状態。
  private starStateAt(jdTdb: number): BarycentricState {
    if (this.lastStarState === null || this.lastStarJdTdb !== jdTdb) {
      this.lastStarState = this.absolute.barycentricStateOf(this.starId, jdTdb);
      this.lastStarJdTdb = jdTdb;
    }
    return this.lastStarState;
  }
}
