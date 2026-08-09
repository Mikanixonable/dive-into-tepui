// 時刻付きの太陽系重心状態を供給する層と、ゲームが使う中心天体基準へ落とす層。
// 暦データの表現(Chebyshev/SPK/テスト用解析解)と座標原点の選択を分離する。
import { AttractorId } from './attractor';
import { KinematicState, kinematicState } from './kinematic-state';
import { Vec3, sub, v3 } from './vec3';

export type BarycentricState = {
  readonly r: Vec3; // ICRF/J2000 [m]
  readonly v: Vec3; // ICRF/J2000 [m/s]
};

export interface AbsoluteEphemeris {
  readonly validStartJdTdb: number;
  readonly validEndJdTdb: number;
  hasBody(id: AttractorId): boolean;
  barycentricStateOf(id: AttractorId, jdTdb: number): BarycentricState;
}

export class MissingEphemerisBodyError extends Error {
  constructor(readonly bodyId: AttractorId) {
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
  constructor(
    private readonly absolute: AbsoluteEphemeris,
    readonly originId: AttractorId,
    readonly epochJdTdb: number,
  ) {
    if (!absolute.hasBody(originId)) throw new MissingEphemerisBodyError(originId);
  }

  hasBody(id: AttractorId): boolean {
    return this.absolute.hasBody(id);
  }

  stateOf(id: AttractorId, simTime: number): KinematicState {
    if (!this.absolute.hasBody(id)) throw new MissingEphemerisBodyError(id);
    const jdTdb = this.epochJdTdb + simTime / 86400;
    const body = this.absolute.barycentricStateOf(id, jdTdb);
    const origin = this.absolute.barycentricStateOf(this.originId, jdTdb);
    return kinematicState(
      simTime,
      icrfToGameEci(sub(body.r, origin.r)),
      icrfToGameEci(sub(body.v, origin.v)),
    );
  }
}
