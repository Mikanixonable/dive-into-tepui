// 時刻付きの太陽系重心状態を供給する層と、ゲームが使う中心天体基準へ落とす層。
// 暦データの表現(Chebyshev/SPK/テスト用解析解)と座標原点の選択を分離する。
import { CelestialBodyId } from './celestial-body';
import { KinematicState, kinematicState } from './kinematic-state';
import { Vec3, sub, v3 } from '../math/vec3';

export type BarycentricState = {
  readonly r: Vec3; // ICRF/J2000 [m]
  readonly v: Vec3; // ICRF/J2000 [m/s]
};

export interface AbsoluteEphemeris {
  readonly validStartJdTdb: number;
  readonly validEndJdTdb: number;
  hasBody(id: CelestialBodyId): boolean;
  barycentricStateOf(id: CelestialBodyId, jdTdb: number): BarycentricState;
}

export class MissingEphemerisBodyError extends Error {
  constructor(readonly bodyId: CelestialBodyId) {
    super(`天体暦に天体 ${bodyId} が含まれていない`);
    this.name = 'MissingEphemerisBodyError';
  }
}

// ICRF の (X,Y,Z)=(春分点方向, 赤道面内, 北極) を、ゲームの
// (X,Y,Z)=(春分点方向, 北極, -赤道面内) へ右手系のまま写す。
export function icrfToGameEci(a: Vec3): Vec3 {
  return v3(a.x, a.z, a.y === 0 ? 0 : -a.y);
}

export class OriginCenteredEphemeris {
  // 直前に引いた時刻の原点天体の状態。同じ時刻で複数の天体を引くとき、原点側の評価は
  // 天体ごとに同じ値を返すので1回で足りる。
  private lastOriginJdTdb = NaN;
  private lastOriginState: BarycentricState | null = null;

  constructor(
    private readonly absolute: AbsoluteEphemeris,
    readonly originId: CelestialBodyId,
    readonly epochJdTdb: number,
  ) {
    if (!absolute.hasBody(originId)) throw new MissingEphemerisBodyError(originId);
  }

  hasBody(id: CelestialBodyId): boolean {
    return this.absolute.hasBody(id);
  }

  // simTime に対応する jdTdb が absolute の有効期間内かどうか。
  isValidAt(simTime: number): boolean {
    const jdTdb = this.epochJdTdb + simTime / 86400;
    return jdTdb >= this.absolute.validStartJdTdb && jdTdb <= this.absolute.validEndJdTdb;
  }

  // 天体 id の、originId 中心・ゲーム ECI 軸の状態。収録されていない天体は例外を投げる。
  stateOf(id: CelestialBodyId, simTime: number): KinematicState {
    if (!this.absolute.hasBody(id)) throw new MissingEphemerisBodyError(id);
    const jdTdb = this.epochJdTdb + simTime / 86400;
    const body = this.absolute.barycentricStateOf(id, jdTdb);
    const origin = this.originStateAt(jdTdb);
    return kinematicState(
      simTime,
      icrfToGameEci(sub(body.r, origin.r)),
      icrfToGameEci(sub(body.v, origin.v)),
    );
  }

  // 時刻 jdTdb の原点天体の重心状態。
  private originStateAt(jdTdb: number): BarycentricState {
    if (this.lastOriginState === null || this.lastOriginJdTdb !== jdTdb) {
      this.lastOriginState = this.absolute.barycentricStateOf(this.originId, jdTdb);
      this.lastOriginJdTdb = jdTdb;
    }
    return this.lastOriginState;
  }
}
