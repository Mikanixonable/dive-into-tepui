// 回帰テスト間で共有する検証ヘルパ。
import * as assert from 'node:assert/strict';
import { AbsoluteEphemeris } from '../../src/physics/absolute-ephemeris';
import type { CelestialBodyWindows } from '../../src/physics/celestial-body-windows';
import { CelestialMotion, OrbitingMotion, PhaseOffsets } from '../../src/physics/celestial-motion';
import { FrameRotation } from '../../src/physics/kepler-orbit';
import type { ReferenceFrames } from '../../src/physics/reference-frames';
import { EPOCH_T_OFFSET } from '../../src/physics/solar-system/constants';
import { solarSystem } from '../../src/game/celestial/solar-system/solar-system';
import { SECONDS_PER_DAY } from '../../src/physics/time';
import { Vec3, cross, len, scale, sub, v3 } from '../../src/math/vec3';
import { qRotate } from '../../src/physics/attitude';

// 地球原点で組んだ現実の太陽系。天体は宣言順(重力源配列・一覧の順序もこの並び)に並び、
// 1体ずつは id で引く。系レベルの天体一覧の窓と座標系も一緒に持つ。
export type SolarSystemParts = {
  readonly bodies: readonly CelestialMotion[];
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
  const system = solarSystem('earth', phases, 0, absoluteSource, epochOffsetSec, epochJdTdb);
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

// 天体 id の時刻 t での ECI 位置。
export function positionOf(parts: SolarSystemParts, id: string, t: number): Vec3 {
  return motionOf(parts, id).stateAt(t).r;
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
