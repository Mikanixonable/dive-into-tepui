// 座標系(ReferenceFrame)・天体(AttractorId)に日本語表示名を対応させる表。天体の表示名自体は
// game/celestial/celestial-registry.ts が唯一の定義元で、ここは参照するだけ。
import { ReferenceFrame } from '../../physics/frame';
import { AttractorId } from '../../physics/attractor';
import { bodyDef, primaryOf } from '../../physics/solar-system';
import { CELESTIAL_BODIES } from '../celestial/celestial-registry';
import type { Ephemeris } from '../../physics/ephemeris';

export const ATTRACTOR_NAMES: Record<AttractorId, string> = Object.fromEntries(
  Object.entries(CELESTIAL_BODIES).map(([id, v]) => [id, v.name]),
) as Record<AttractorId, string>;

// ephemeris.frames の各要素に表示名をつける。回転しない系は「(天体名)中心慣性系」、回転する系は
// 「(回っている天体の親の名)-(回っている天体の名)回転系」。値は必ず ephemeris.frames の要素
// そのものを使う(参照同一性が sampled-line.ts のキャッシュ判定の前提)。
// 選ばせるのは重力源天体の系だけ — 重力積分の対象でない天体を中心に据えても、そこでの
// 局所力学が成立していないので軌道が読み取れない。
export function frameItems(ephemeris: Ephemeris): readonly (readonly [ReferenceFrame, string])[] {
  const registry = ephemeris.registry;
  return ephemeris.frames.filter(
    (frame) => bodyDef(registry, frame.center).gravitySource
      && (frame.rotatingWith === null || bodyDef(registry, frame.rotatingWith).gravitySource),
  ).map((frame) => [
    frame,
    frame.rotatingWith === null
      ? `${ATTRACTOR_NAMES[frame.center]}中心慣性系`
      : `${ATTRACTOR_NAMES[primaryOf(registry, frame.rotatingWith) ?? frame.rotatingWith]}-${ATTRACTOR_NAMES[frame.rotatingWith]}回転系`,
  ] as const);
}
