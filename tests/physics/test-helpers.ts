// 回帰テスト間で共有する検証ヘルパ。
import * as assert from 'node:assert/strict';
import { AbsoluteEphemeris, BarycentricState, icrfToGameEci } from '../../src/physics/absolute-ephemeris';
import { BodyEphemeris } from '../../src/physics/body-ephemeris';
import { kinematicState } from '../../src/physics/kinematic-state';
import { KinematicState } from '../../src/physics/kinematic-state';
import {
  LagrangePoints, SecondaryFrame, lagrangePointsOf, secondaryFrameOf,
} from '../../src/physics/lagrange';
import type { CelestialBodyWindows } from '../../src/physics/celestial-body-windows';
import { CelestialMotion, OrbitingMotion, PhaseOffsets } from '../../src/physics/celestial-motion';
import { FrameRotation } from '../../src/physics/kepler-orbit';
import type { ReferenceFrames } from '../../src/physics/reference-frames';
// 回帰テストが simTime = 0 に置く瞬間の、J2000 からの秒数。地球から見て太陽が +X 方向
// (昼側)にある — すなわち地球の日心黄経が π になる — 瞬間へ合わせてある。
// 導出: 地球の平均黄経 L(t) = l0 + L̇·t を L = 180° と置いて解く。
//   (180° − 100.46457166°) / 35999.37244981 [deg/Cy] × JULIAN_CENTURY = 6.9721972e6 s。
// 中心差(真黄経と平均黄経の差)は地球の e = 0.0167 で高々 ±1.9° あるが、これは見た目の
// 昼夜を合わせるためのアンカーなので平均黄経で足りる。
export const TEST_SIM_ZERO_ET = 6972197.1872752225;
import { solarSystem } from '../../src/game/celestial/solar-system/solar-system';
import { createJulianDate, J2000_JULIAN_DATE, SECONDS_PER_DAY, TdbJulianDate } from '../../src/physics/time';
import { Vec3, cross, len, scale, sub, v3 } from '../../src/math/vec3';
import { qRotate } from '../../src/physics/attitude';

// 地球原点で組んだ現実の太陽系。天体は宣言順(重力源配列・一覧の順序もこの並び)に並び、
// 1体ずつは id で引く。系レベルの天体一覧の窓と座標系も一緒に持つ。
export type SolarSystemParts = {
  readonly bodies: readonly CelestialMotion[];
  readonly windows: CelestialBodyWindows;
  readonly referenceFrames: ReferenceFrames;
};

// 回帰テストが既定で使う元期。TEST_SIM_ZERO_ET は「simTime=0 を、地球の日心黄経が π になる
// 瞬間へ合わせる」ための J2000 からの秒数で、その瞬間を絶対時刻として表したものがこれ。
export const TEST_EPOCH: TdbJulianDate =
  createJulianDate('TDB', J2000_JULIAN_DATE + TEST_SIM_ZERO_ET / SECONDS_PER_DAY);

// 現実の太陽系を地球原点で組む。phases は天体ごとの平均黄経の初期位相 [rad]、
// epoch は simTime=0 が指す絶対時刻。absoluteSource を渡すと、その有効期間だけ
// 高精度暦パック経路を通る。
export function solarSystemParts(
  phases: PhaseOffsets = {},
  epoch: TdbJulianDate = TEST_EPOCH,
  absoluteSource: AbsoluteEphemeris | null = null,
): SolarSystemParts {
  const system = solarSystem('earth', phases, 0, absoluteSource, epoch);
  return { bodies: system.motions, windows: system.windows, referenceFrames: system.frames };
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
  const frame = secondaryFrameOf(parts.windows.celestialBodiesAt(t), orbitingMotionOf(parts, id), t);
  if (frame === null) throw new Error(`ラグランジュ点を組めない天体 id: ${id}`);
  return lagrangePointsOf(frame);
}

// 天体 id の時刻 t における SecondaryFrame。組めない id は例外。
export function secondaryFrameFor(parts: SolarSystemParts, id: string, t: number): SecondaryFrame {
  const frame = secondaryFrameOf(parts.windows.celestialBodiesAt(t), orbitingMotionOf(parts, id), t);
  if (frame === null) throw new Error(`SecondaryFrame を組めない天体 id: ${id}`);
  return frame;
}

// 天体 id の時刻 t での ECI 位置・速度。
export function stateOf(parts: SolarSystemParts, id: string, t: number): KinematicState {
  return parts.windows.stateAt(id, t);
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

// 天体 id ごとの重心状態(ICRF 軸)を返す関数から、テスト用の暦供給源を組む。**収録して
// いない天体には null を返させる** — 収録の有無をテスト側で二重に宣言せずに済む。
export function testEphemerisSource(
  validStartSimTime: number,
  validEndSimTime: number,
  stateOf: (id: string, simTime: number) => BarycentricState | null,
): AbsoluteEphemeris {
  const bodyEphemerisOf = (id: string): BodyEphemeris | null => {
    if (stateOf(id, validStartSimTime) === null) return null;
    return {
      validStartSimTime,
      validEndSimTime,
      stateAt: (simTime: number) => {
        const state = stateOf(id, simTime);
        if (state === null) throw new Error(`testEphemerisSource: 収録していない天体 id: ${id}`);
        return kinematicState<'barycentric'>(simTime, icrfToGameEci(state.r), icrfToGameEci(state.v));
      },
    };
  };
  return {
    validStartSimTime,
    validEndSimTime,
    hasBody: (id) => stateOf(id, validStartSimTime) !== null,
    barycentricStateOf: (id, simTime) => {
      const state = stateOf(id, simTime);
      if (state === null) throw new Error(`testEphemerisSource: 収録していない天体 id: ${id}`);
      return state;
    },
    bodyEphemerisOf,
  };
}
