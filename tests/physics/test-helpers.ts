// 回帰テスト間で共有する検証ヘルパ。
import * as assert from 'node:assert/strict';
import { AbsoluteEphemeris } from '../../src/physics/absolute-ephemeris';
import { PhaseOffsets } from '../../src/physics/celestial-motion';
import { EPOCH_T_OFFSET, Ephemeris } from '../../src/physics/ephemeris';
import { FrameRotation } from '../../src/physics/kepler-orbit';
import { solarSystemMotions } from '../../src/physics/solar-system/solar-system';
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
