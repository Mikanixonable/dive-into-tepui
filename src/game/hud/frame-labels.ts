// 座標系(ReferenceFrame)・天体(AttractorId)に日本語表示名を対応させる表。天体の表示名自体は
// game/celestial/celestial-registry.ts が唯一の定義元で、ここは参照するだけ。
import { ReferenceFrame } from '../../physics/frame';
import { Attractor, AttractorId } from '../../physics/attractor';
import { SolarSystemId, primaryOf } from '../../physics/solar-system';
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
// 登録天体の座標系一覧に、attractors に渡した重力を持つ生存中の GameEntity(レジストリ
// 未登録)ぶんの慣性系を足して返す。動的天体は自転をモデル化しないので回転系の変種を作らない。
export function frameItems(ephemeris: Ephemeris, attractors: readonly Attractor[]): readonly (readonly [ReferenceFrame, string])[] {
  const registry = ephemeris.registry;
  const registered = ephemeris.frames.map((frame) => [
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
