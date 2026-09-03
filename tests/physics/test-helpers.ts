// 回帰テスト間で共有する検証ヘルパ。
import * as assert from 'node:assert/strict';
import { icrfToGameEci } from '../../src/physics/icrf';
import { EphemerisPointKind, EphemerisPoints, PointEphemeris } from '../../src/physics/ephemeris/point';
import { kinematicState } from '../../src/physics/kinematic-state';
import { KinematicState } from '../../src/physics/kinematic-state';
import {
  LagrangePoints, SecondaryFrame, lagrangePointsOf, secondaryFrameOf,
} from '../../src/physics/lagrange';
import {
  BodyOrientation, CelestialBodyDef, CelestialKind, CelestialMotion, OrbitingMotion, PhaseOffsets,
  StarDef,
} from '../../src/physics/celestial-motion';
import { EciTransform } from '../../src/physics/eci-transform';
import type { Atmosphere } from '../../src/physics/atmosphere';
import type { Degree2Gravity } from '../../src/physics/celestial-body-def';
import { FrameRotation } from '../../src/physics/kepler-orbit';
import type { ReferenceFrames } from '../../src/game/celestial/reference-frames';
// 回帰テストが simTime = 0 に置く瞬間の、J2000 からの秒数。地球から見て太陽が +X 方向
// (昼側)にある — すなわち地球の日心黄経が π になる — 瞬間へ合わせてある。
// 導出: 地球の平均黄経 L(t) = l0 + L̇·t を L = 180° と置いて解く。
//   (180° − 100.46457166°) / 35999.37244981 [deg/Cy] × JULIAN_CENTURY = 6.9721972e6 s。
// 中心差(真黄経と平均黄経の差)は地球の e = 0.0167 で高々 ±1.9° あるが、これは見た目の
// 昼夜を合わせるためのアンカーなので平均黄経で足りる。
export const TEST_SIM_ZERO_ET = 6972197.1872752225;
import type { CelestialSystem } from '../../src/game/celestial/celestial-system';
import { solarSystem } from '../../src/game/celestial/solar-system/solar-system';
import { createJulianDate, J2000_JULIAN_DATE, SECONDS_PER_DAY, TdbJulianDate } from '../../src/physics/time';
import { Vec3, addScaled, cross, len, scale, sub, v3 } from '../../src/math/vec3';
import { qRotate } from '../../src/math/quat';

// 地球原点で組んだ現実の太陽系。天体は宣言順(重力源配列・一覧の順序もこの並び)に並び、
// 1体ずつは id で引く。同一時刻の集合を答える系と、座標系も一緒に持つ。
export type SolarSystemParts = {
  readonly bodies: readonly CelestialMotion[];
  readonly system: CelestialSystem;
  readonly referenceFrames: ReferenceFrames;
};

// 回帰テストが既定で使う元期。TEST_SIM_ZERO_ET は「simTime=0 を、地球の日心黄経が π になる
// 瞬間へ合わせる」ための J2000 からの秒数で、その瞬間を絶対時刻として表したものがこれ。
export const TEST_EPOCH: TdbJulianDate =
  createJulianDate('TDB', J2000_JULIAN_DATE + TEST_SIM_ZERO_ET / SECONDS_PER_DAY);

// 現実の太陽系を地球原点で組む。phases は天体ごとの平均黄経の初期位相 [rad]、
// epoch は simTime=0 が指す絶対時刻。ephemerisPoints を渡すと、そこに載っている天体だけが
// その有効期間で数値暦経路を通る。
export function solarSystemParts(
  phases: PhaseOffsets = {},
  epoch: TdbJulianDate = TEST_EPOCH,
  ephemerisPoints: EphemerisPoints | null = null,
): SolarSystemParts {
  const system = solarSystem('earth', phases, 0, ephemerisPoints, epoch);
  return { bodies: system.celestialMotions, system, referenceFrames: system.frames };
}

// 天体 id の運動。太陽系に登録されていない id を渡すと例外。
export function motionOf(parts: SolarSystemParts, id: string): CelestialMotion {
  const motion = parts.bodies.find((m) => m.id === id);
  if (motion === undefined) throw new Error(`太陽系に登録されていない天体 id: ${id}`);
  return motion;
}

// 公転している天体 id の運動。恒星や未登録の id を渡すと例外。
export function orbitingMotionOf(parts: SolarSystemParts, id: string): OrbitingMotion {
  const motion = motionOf(parts, id);
  if (!(motion instanceof OrbitingMotion)) throw new Error(`公転していない天体 id: ${id}`);
  return motion;
}

// 天体 id の時刻 t におけるラグランジュ点(ECI)。公転していない・主天体が引けない id は例外。
export function lagrangeOf(parts: SolarSystemParts, id: string, t: number): LagrangePoints {
  const frame = secondaryFrameOf(parts.system.celestialMotions, t, orbitingMotionOf(parts, id), t);
  if (frame === null) throw new Error(`ラグランジュ点を組めない天体 id: ${id}`);
  return lagrangePointsOf(frame);
}

// 天体 id の時刻 t における SecondaryFrame。組めない id は例外。
export function secondaryFrameFor(parts: SolarSystemParts, id: string, t: number): SecondaryFrame {
  const frame = secondaryFrameOf(parts.system.celestialMotions, t, orbitingMotionOf(parts, id), t);
  if (frame === null) throw new Error(`SecondaryFrame を組めない天体 id: ${id}`);
  return frame;
}

// 天体 id の時刻 t での ECI 位置・速度。
export function stateOf(parts: SolarSystemParts, id: string, t: number): KinematicState {
  return parts.system.stateAt(id, t);
}

// 天体 id の時刻 t での ECI 位置。
export function positionOf(parts: SolarSystemParts, id: string, t: number): Vec3 {
  return stateOf(parts, id, t).r;
}

// 回転基準系の角速度が姿勢の時間微分と整合するか(基底の各軸で ḃ = ω×b)を中心差分で確かめる。
export function assertOmegaMatchesBasis(rot: (t: number) => FrameRotation, t: number, dt: number): void {
  const { omega } = rot(t);
  for (const axis of [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)]) {
    const at = (s: number): Vec3 => qRotate(rot(s).q, axis);
    const fd = scale(sub(at(t + dt), at(t - dt)), 1 / (2 * dt));
    const analytic = cross(omega, at(t));
    assert.ok(
      len(sub(fd, analytic)) < 1e-4 * len(omega),
      `角速度の不一致 (t=${t}, axis=${JSON.stringify(axis)}): ${JSON.stringify(fd)} vs ${JSON.stringify(analytic)}`,
    );
  }
}

// 天体 id ごとの重心状態(ICRF 軸)を閉じた式で与えて、テスト用の暦の一覧を組む。
// **表に載せた id だけが収録されている** — どの天体がパック経路へ入り、どれが解析経路へ
// 落ちるかは、この表の顔ぶれがそのまま決める。
// pointKinds は天体本体でなく惑星系の重心を収録している id の宣言(既定は全部が本体)。
export function testEphemerisPoints(
  validStartSimTime: number,
  validEndSimTime: number,
  statesOf: Readonly<Record<string, (simTime: number) => { readonly r: Vec3; readonly v: Vec3 }>>,
  pointKinds: Readonly<Partial<Record<string, EphemerisPointKind>>> = {},
): EphemerisPoints {
  const points = new Map<string, { kind: EphemerisPointKind; ephemeris: PointEphemeris }>();
  for (const [id, stateOf] of Object.entries(statesOf)) {
    const ephemeris: PointEphemeris = {
      validStartSimTime,
      validEndSimTime,
      baryStateAt: (simTime: number) => {
        const state = stateOf(simTime);
        return kinematicState<'numeric'>(simTime, icrfToGameEci(state.r), icrfToGameEci(state.v));
      },
    };
    points.set(id, { kind: pointKinds[id] ?? 'body', ephemeris });
  }
  return points;
}

// 位置・速度・加速度と重力場・大気を宣言した値で答える天体の運動。ECI 原点には静止した基準を
// 置くので、宣言した値がそのまま ECI 値になる。**回帰テストが天体1体を組むための道具**で、
// 位置は anchor から等加速度で伸ばした二次曲線に乗る。
class FixedMotion extends CelestialMotion {
  readonly def: CelestialBodyDef;
  readonly kind: CelestialKind;

  constructor(
    def: StarDef,
    private readonly anchor: KinematicState,
    private readonly accel: Vec3,
    kind: CelestialKind,
    private readonly degree2: Degree2Gravity | null,
    private readonly atmosphere: Atmosphere | null,
  ) {
    super();
    this.def = def;
    this.kind = kind;
  }

  get primary(): CelestialMotion | null { return null; }

  analyticStateAt(t: number): KinematicState<'analytic'> {
    const s = t - this.anchor.t;
    return kinematicState<'analytic'>(
      t,
      addScaled(addScaled(this.anchor.r, this.anchor.v, s), this.accel, 0.5 * s * s),
      addScaled(this.anchor.v, this.accel, s),
    );
  }

  analyticAccelAt(): Vec3 { return this.accel; }

  orientationAt(): BodyOrientation | null { return null; }

  protected computeDegree2At(): Degree2Gravity | null { return this.degree2; }

  protected computeAtmosphereAt(): Atmosphere | null { return this.atmosphere; }
}

// ECI 原点に置く、太陽系重心に静止した基準。FixedMotion の ECI 化を恒等変換にする。
const FIXED_ORIGIN = new FixedMotion(
  { id: '@fixed-origin', mu: 0, radius: 0 },
  kinematicState<'eci'>(0, v3(), v3()), v3(), 'star', null, null,
);
const FIXED_ECI = new EciTransform(FIXED_ORIGIN);

// 宣言した瞬間値だけを答える天体を1体組む。state は anchor(その時刻で厳密)、accel は
// そこから伸びる二次曲線の加速度。
export function fixedMotion(spec: {
  readonly id: string;
  readonly mu: number;
  readonly radius: number;
  readonly state: KinematicState;
  readonly accel?: Vec3;
  readonly kind?: CelestialKind;
  readonly degree2?: Degree2Gravity | null;
  readonly atmosphere?: Atmosphere | null;
}): CelestialMotion {
  const motion = new FixedMotion(
    { id: spec.id, mu: spec.mu, radius: spec.radius },
    spec.state, spec.accel ?? v3(), spec.kind ?? 'planet',
    spec.degree2 ?? null, spec.atmosphere ?? null,
  );
  motion.bindEciTransform(FIXED_ECI);
  return motion;
}
