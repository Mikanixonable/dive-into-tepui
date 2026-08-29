// 現実の太陽系の game 側パック: physics 側パック(solarSystemMotions)が組んだ運動に
// 見た目(CelestialEntity)を対応づけ、CelestialSystem を返す構築コードの入口。
import { AbsoluteEphemeris } from '../../../physics/absolute-ephemeris';
import { PhaseOffsets } from '../../../physics/celestial-motion';
import {
  SolarSystemId, solarSystemMotions,
} from '../../../physics/solar-system/solar-system';
import { CelestialSystem } from '../celestial-system';
import type { CelestialEntity } from '../celestial-entity';
import { Sun } from '../sun';
import { DWARF_PLANET_NAMES, dwarfPlanetEntities } from './dwarf-planets';
import { EARTH_SYSTEM_NAMES, earthSystemEntities } from './earth-system';
import { INNER_PLANET_NAMES, innerPlanetEntities } from './inner-planets';
import { JUPITER_SYSTEM_NAMES, jupiterSystemEntities } from './jupiter-system';
import { MARS_SYSTEM_NAMES, marsSystemEntities } from './mars-system';
import { NEPTUNE_SYSTEM_NAMES, neptuneSystemEntities } from './neptune-system';
import { SATURN_SYSTEM_NAMES, saturnSystemEntities } from './saturn-system';
import { SMALL_BODY_NAMES, smallBodyEntities } from './small-bodies';
import { URANUS_SYSTEM_NAMES, uranusSystemEntities } from './uranus-system';

// 太陽系の全天体の表示名。各系ファイルの表を1つに合わせたもので、名前の正本は系ファイルのまま。
export const SOLAR_SYSTEM_BODY_NAMES: Record<SolarSystemId, string> = {
  sun: '太陽',
  ...EARTH_SYSTEM_NAMES,
  ...INNER_PLANET_NAMES,
  ...MARS_SYSTEM_NAMES,
  ...JUPITER_SYSTEM_NAMES,
  ...SATURN_SYSTEM_NAMES,
  ...URANUS_SYSTEM_NAMES,
  ...NEPTUNE_SYSTEM_NAMES,
  ...DWARF_PLANET_NAMES,
  ...SMALL_BODY_NAMES,
};

// 天体 id の表示名。星系を組まずに引ける静的な引き先で、太陽系に無い id はそのまま返す。
export function solarSystemBodyName(id: string): string {
  return SOLAR_SYSTEM_BODY_NAMES[id as SolarSystemId] ?? id;
}

// 太陽系の CelestialSystem を組む。originId は ECI の中心天体(ステージの選択)、
// earthSpinPhase0 は地球の自転初期位相 [rad]。absoluteSource を渡すと、その有効期間だけ
// 高精度暦パック経路を通る(epochJdTdb はそのパックの元期)。
export function solarSystem(
  originId: SolarSystemId, phases: PhaseOffsets, earthSpinPhase0: number,
  absoluteSource: AbsoluteEphemeris | null, epochOffsetSec: number, epochJdTdb: number,
): CelestialSystem {
  const m = solarSystemMotions(originId, phases, epochOffsetSec, absoluteSource, epochJdTdb, earthSpinPhase0);
  // Record の網羅性検査が「physics 側に居る天体に見た目が無い」をコンパイルエラーにする。
  const e: Record<SolarSystemId, CelestialEntity> = {
    sun: new Sun(m.sun, SOLAR_SYSTEM_BODY_NAMES.sun),
    ...earthSystemEntities(m.earthSystem),
    ...innerPlanetEntities(m.innerPlanets),
    ...marsSystemEntities(m.marsSystem),
    ...jupiterSystemEntities(m.jupiterSystem),
    ...saturnSystemEntities(m.saturnSystem),
    ...uranusSystemEntities(m.uranusSystem),
    ...neptuneSystemEntities(m.neptuneSystem),
    ...dwarfPlanetEntities(m.dwarfPlanets),
    ...smallBodyEntities(m.smallBodies),
  };
  const bodies = m.all.map((motion) => e[motion.id as SolarSystemId]);
  const origin = e[originId];
  return new CelestialSystem(bodies, origin, phases);
}
