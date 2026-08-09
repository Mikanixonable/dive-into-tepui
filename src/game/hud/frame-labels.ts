// 座標系(ReferenceFrame)・天体(AttractorId)に日本語表示名を対応させる表。天体の表示名自体は
// game/celestial/celestial-registry.ts が唯一の定義元で、ここは参照するだけ。
import { ReferenceFrame } from '../../physics/frame';
import { Attractor, AttractorId } from '../../physics/attractor';
import { SolarSystemId, bodyDef, primaryOf } from '../../physics/solar-system';
import { CELESTIAL_BODIES } from '../celestial/celestial-registry';
import type { Ephemeris } from '../../physics/ephemeris';

// id の日本語表示名。CELESTIAL_BODIES に手作りエントリがある(現実の太陽系27体)ならそれを、
// なければ(カスタムレジストリの架空天体)id をそのまま表示名として使う。
export function celestialBodyName(id: AttractorId): string {
  return id in CELESTIAL_BODIES ? CELESTIAL_BODIES[id as SolarSystemId].name : id;
}

// ephemeris.frames の各要素に表示名をつける。回転しない系は「(天体名)中心慣性系」、回転する系は
// 「(回っている天体の親の名)-(回っている天体の名)回転系」。値は必ず ephemeris.frames の要素
// そのものを使う(参照同一性が sampled-line.ts のキャッシュ判定の前提)。
// 選ばせるのは重力源天体の系だけ — 重力積分の対象でない天体を中心に据えても、そこでの
// 局所力学が成立していないので軌道が読み取れない。attractors に渡した重力を持つ生存中の
// GameEntity(レジストリ未登録)は、慣性系1つだけを frameFor 経由で追加する — 自転を
// モデル化しないので回転系の変種は作らない(§2-4)。
export function frameItems(ephemeris: Ephemeris, attractors: readonly Attractor[]): readonly (readonly [ReferenceFrame, string])[] {
  const registry = ephemeris.registry;
  const registered = ephemeris.frames.filter(
    (frame) => bodyDef(registry, frame.center).gravitySource
      && (frame.rotatingWith === null || bodyDef(registry, frame.rotatingWith).gravitySource),
  ).map((frame) => [
    frame,
    frame.rotatingWith === null
      ? `${celestialBodyName(frame.center)}中心慣性系`
      : `${celestialBodyName(primaryOf(registry, frame.rotatingWith) ?? frame.rotatingWith)}-${celestialBodyName(frame.rotatingWith)}回転系`,
  ] as const);
  const dynamic = attractors
    .filter((a) => !(a.id in registry))
    .map((a) => [ephemeris.frameFor(a.id), `${celestialBodyName(a.id)}中心慣性系`] as const);
  return [...registered, ...dynamic];
}
