// 回帰テスト間で共有する検証ヘルパ。
import * as assert from 'node:assert/strict';
import { AbsoluteEphemeris } from '../../src/physics/absolute-ephemeris';
import { CelestialBodyWindows } from '../../src/physics/celestial-body-windows';
import { CelestialMotion, OrbitingMotion, PhaseOffsets } from '../../src/physics/celestial-motion';
import { Ephemeris } from '../../src/physics/ephemeris';
import { FrameRotation } from '../../src/physics/kepler-orbit';
import { ReferenceFrames } from '../../src/physics/reference-frames';
import { EPOCH_T_OFFSET } from '../../src/physics/solar-system/constants';
import { SolarSystemMotions, solarSystemMotions } from '../../src/physics/solar-system/solar-system';
import { SECONDS_PER_DAY } from '../../src/physics/time';
import { Vec3, cross, len, scale, sub, v3 } from '../../src/math/vec3';
import { qRotate } from '../../src/physics/attitude';

// 現実の太陽系を地球原点で組んだ天体暦。phases は天体ごとの平均黄経の初期位相 [rad]。
// absoluteSource を渡すと、その有効期間だけ高精度暦パック経路を通る。
export function solarSystemEphemeris(
  phases: PhaseOffsets = {},
  epochOffsetSec: number = EPOCH_T_OFFSET,
  absoluteSource: AbsoluteEphemeris | null = null,
  epochJdTdb: number = 2451545 + epochOffsetSec / SECONDS_PER_DAY,
): Ephemeris {
  const motions = solarSystemMotions('earth', phases, epochOffsetSec, absoluteSource, epochJdTdb);
  return new Ephemeris(motions.all, 'earth', phases);
}

// 地球原点で組んだ現実の太陽系。天体1体ずつの運動と、系レベルの天体一覧の窓・座標系。
export type SolarSystemParts = {
  readonly motions: SolarSystemMotions;
  readonly windows: CelestialBodyWindows;
  readonly referenceFrames: ReferenceFrames;
};

// 現実の太陽系を地球原点で組む。phases は天体ごとの平均黄経の初期位相 [rad]。
// absoluteSource を渡すと、その有効期間だけ高精度暦パック経路を通る。
export function solarSystemParts(
  phases: PhaseOffsets = {},
  epochOffsetSec: number = EPOCH_T_OFFSET,
  absoluteSource: AbsoluteEphemeris | null = null,
  epochJdTdb: number = 2451545 + epochOffsetSec / SECONDS_PER_DAY,
): SolarSystemParts {
  const motions = solarSystemMotions('earth', phases, epochOffsetSec, absoluteSource, epochJdTdb);
  return {
    motions,
    windows: new CelestialBodyWindows(motions.all),
    referenceFrames: new ReferenceFrames(motions.all, motionOf(motions, 'earth')),
  };
}

// 天体 id の運動。太陽系に登録されていない id を渡すと例外。
export function motionOf(motions: SolarSystemMotions, id: string): CelestialMotion {
  const motion = motions.all.find((m) => m.id === id);
  if (motion === undefined) throw new Error(`太陽系に登録されていない天体 id: ${id}`);
  return motion;
}

// 公転している天体 id の運動。恒星や未登録の id を渡すと例外。
export function orbitingMotionOf(motions: SolarSystemMotions, id: string): OrbitingMotion {
  const motion = motionOf(motions, id);
  if (!(motion instanceof OrbitingMotion)) throw new Error(`公転していない天体 id: ${id}`);
  return motion;
}

// 天体 id の時刻 t での ECI 位置。
export function positionOf(motions: SolarSystemMotions, id: string, t: number): Vec3 {
  return motionOf(motions, id).stateAt(t).r;
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
