// 天体(CelestialBodyId)の日本語表示名の引き当て。表示名自体は
// game/celestial/celestial-registry.ts が唯一の定義元で、ここは参照するだけ。
import { CelestialBodyId } from '../../physics/celestial-body';
import { SolarSystemId } from '../../physics/solar-system';
import { CELESTIAL_VIEWS } from '../celestial/celestial-registry';

// id の日本語表示名。CELESTIAL_VIEWS に手作りエントリがある(現実の太陽系の天体)ならそれを、
// なければ(カスタムレジストリの架空天体)id をそのまま表示名として使う。
export function celestialBodyName(id: CelestialBodyId): string {
  return id in CELESTIAL_VIEWS ? CELESTIAL_VIEWS[id as SolarSystemId].name : id;
}
