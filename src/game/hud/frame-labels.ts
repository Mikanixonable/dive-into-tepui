// 座標系(ReferenceFrame)に日本語表示名を対応させる表。天体の表示名自体は
// game/celestial/celestial-registry.ts が唯一の定義元で、ここは参照するだけ。
import { ReferenceFrame, FRAMES } from '../../physics/frame';
import { AttractorId, PlanetId, SatelliteId } from '../../physics/attractor';
import { primaryOf } from '../../physics/solar-system';
import { CELESTIAL_VIEWS } from '../celestial/celestial-registry';

export const ATTRACTOR_NAMES: Record<AttractorId, string> = Object.fromEntries(
  Object.entries(CELESTIAL_VIEWS).map(([id, v]) => [id, v.name]),
) as Record<AttractorId, string>;

// FRAMES の各要素に表示名をつける。回転しない系は「(天体名)中心慣性系」、回転する系は
// 「(回っている天体の親の名)-(回っている天体の名)回転系」。値は必ず FRAMES の要素そのものを
// 使う(参照同一性が sampled-line.ts のキャッシュ判定の前提)。
export const FRAME_ITEMS: readonly (readonly [ReferenceFrame, string])[] = FRAMES.map((frame) => [
  frame,
  frame.rotatingWith === null
    ? `${ATTRACTOR_NAMES[frame.center]}中心慣性系`
    : `${ATTRACTOR_NAMES[primaryOf(frame.rotatingWith as PlanetId | SatelliteId)]}-${ATTRACTOR_NAMES[frame.rotatingWith]}回転系`,
]);
