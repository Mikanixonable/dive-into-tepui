// 地表固定の基地の船体運動。積分はせず、各歩の先端で錨(surface-anchor)から姿勢を解析的に
// 置く。天体表面へ固定されているため、接触で押されても次の歩で錨の位置へ戻る(GAME.md 7.4)。
// 熱の歩は持たない — 温度は初期値のまま推移する。
import { localOrbitPeriod } from '../../physics/attractor';
import type { Attitude } from '../../physics/attitude';
import type { CelestialBody } from '../../physics/celestial-body';
import { isStar } from '../../physics/celestial-body-def';
import { environmentSampleAt } from '../../physics/dynamics';
import type { KinematicState } from '../../physics/kinematic-state';
import { sunlightIrradiance } from '../../physics/thermal';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { DynamicReactionServices } from '../dynamic/dynamic-simulation-participant';
import { DEFAULT_HISTORY_DURATION, trajectorySampleInterval, type PredictedArc } from '../dynamic/predicted-arc';
import { ModularShipMotion, type ModularShipMotionReactions, type ModularShipMotionSystems } from './modular-ship-motion';
import type { ShipAssembly } from './ship-assembly';
import { surfaceAnchorPose, type SurfaceAnchor } from './surface-anchor';

export class AnchoredShipMotion extends ModularShipMotion {
  // 進行の歩の引数から解決した錨の天体。表示時刻の問い合わせが未来を答えるときに使い回す。
  private body: CelestialBody | null = null;

  // assembly と錨から組む。state と attitude は錨から導いた初期姿勢であること。
  public constructor(
    assembly: ShipAssembly,
    state: KinematicState,
    attitude: Attitude,
    reactions: ModularShipMotionReactions,
    systems: ModularShipMotionSystems,
    public readonly anchor: SurfaceAnchor,
  ) {
    super(assembly, state, attitude, reactions, systems);
  }

  // dt 進めた先端へ、錨から導いた姿勢を置く。積分しないので戻り値は常に false。
  // 環境(日照・大気・高度警報)への反応は、通常の船と同じく歩ごとに進める。
  public override stepSimulation(
    dt: number, celestialBodies: readonly CelestialBody[], occluders: readonly CelestialBody[],
    atmosphereBody: CelestialBody | null, star: CelestialBody | null, pivot: number,
    _services: DynamicReactionServices,
  ): boolean {
    const body = celestialBodies.find((candidate) => candidate.def.id === this.anchor.bodyId) ?? this.body;
    const target = this.state.t + dt;
    if (body !== null) {
      this.body = body;
      if (target > this.state.t) {
        const pose = surfaceAnchorPose(this.anchor, body, target, this.centerOffset);
        // 履歴の標本化は、予測弧をなぞる個体と同じ刻み・保持時間で行う。
        const interval = trajectorySampleInterval(
          localOrbitPeriod(pose.state.r, celestialBodies, pivot), DEFAULT_HISTORY_DURATION,
        );
        this.actual.follow(pose.state, interval, DEFAULT_HISTORY_DURATION);
        this.resetAttitude({ q: pose.q, w: pose.w, inertia: this.att.inertia }, this.att);
      }
    }
    // 歩の終わりの環境標本1点で、種別ごとの環境反応を進める。
    const sample = environmentSampleAt(
      target, this.state.r, this.state.v, star, occluders, atmosphereBody, pivot,
    );
    const radiantIntensity = star !== null && isStar(star) ? star.def.radiantIntensity : 0;
    this.behavior.stepEnvironment?.(
      this, dt, atmosphereBody, target,
      sunlightIrradiance(radiantIntensity, sample.sunDist, sample.sunlit), sample.sunDir,
    );
    return false;
  }

  // 未来の状態は予測弧ではなく錨から答える。錨の天体を解決できない問い合わせでは null。
  public override stateAt(t: number, celestialBodies?: CelestialBodies): KinematicState | null {
    if (t <= this.state.t) return super.stateAt(t, celestialBodies);
    const body = celestialBodies?.findMotion(this.anchor.bodyId) ?? this.body;
    if (body === null) return null;
    return surfaceAnchorPose(this.anchor, body, t, this.centerOffset).state;
  }

  // 予測弧は作らない。未来は stateAt が錨から答える。
  public override ensurePredictedArc(_sources: readonly CelestialBody[]): PredictedArc | null {
    return null;
  }
}
