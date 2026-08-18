// このフレームの通信網。通信基地と、通信モジュールを積んだ生存機体を中継点として集め、
// 有効な中継点の集合を求めて CoverageQuery として答える。
//
// 中継点の顔ぶれも位置も秒の単位でしか変わらないので、毎フレームではなく
// COMM_REFRESH_SEC ごとに組み直す(§13-2)。
import type { Ephemeris } from '../../physics/ephemeris';
import type { Vec3 } from '../../physics/vec3';
import type { CapabilityVessel, CoverageQuery } from '../vessel/capabilities';
import { communicationRange, isCommStation } from '../vessel/capabilities';
import { initialCommStations } from './comm-stations';
import { activeRelays, isInCommRange, type CommOccluder, type CommRelay } from './coverage';

export const COMM_REFRESH_SEC = 2;

// 中継点になりうる機体。Vessel が構造的にこれを満たす。
export interface CommVessel extends CapabilityVessel {
  readonly id: string;
  readonly alive: boolean;
}

// 機体が持つ中継能力。通信基地であれば網の起点になり、通信モジュールだけなら既に有効な
// 中継点と繋がったときにだけ中継点になる。通信モジュールが無ければ中継しない。
function relayOf(vessel: CommVessel): CommRelay | null {
  if (!vessel.alive) return null;
  const range = communicationRange(vessel);
  if (range <= 0) return null;
  return { id: vessel.id, pos: vessel.state.r, range, isGround: isCommStation(vessel) };
}

export class CommNetwork implements CoverageQuery {
  private _relays: readonly CommRelay[] = [];
  private _active: readonly CommRelay[] = [];
  private attractors: readonly CommOccluder[] = [];
  private lastBuildAt = Number.NaN;

  // simTime のこのフレームの値と、中継点になりうる機体・遮蔽天体を受け取って網を組み直す。
  // 更新間隔に満たなければ前回の結果をそのまま保つ。
  update(
    simTime: number,
    ephemeris: Ephemeris,
    vessels: readonly CommVessel[],
    attractors: readonly CommOccluder[],
  ): void {
    // 未構築か、前回から更新間隔ぶん進んだか、時刻が巻き戻った(スナップショット読み込み)
    // ときに組み直す。
    if (Math.abs(simTime - this.lastBuildAt) < COMM_REFRESH_SEC) return;
    this.lastBuildAt = simTime;
    this.attractors = attractors;
    const relays: CommRelay[] = [...initialCommStations(ephemeris, simTime)];
    for (const v of vessels) {
      const relay = relayOf(v);
      if (relay) relays.push(relay);
    }
    this._relays = relays;
    this._active = activeRelays(relays, attractors);
  }

  get relays(): readonly CommRelay[] { return this._relays; }
  get active(): readonly CommRelay[] { return this._active; }

  inCoverage(pos: Vec3, moduleRange: number): boolean {
    return isInCommRange(pos, this._active, moduleRange, this.attractors);
  }
}
