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
import { dwarfPlanetEntities } from './dwarf-planets';
import { earthSystemEntities } from './earth-system';
import { innerPlanetEntities } from './inner-planets';
import { jupiterSystemEntities } from './jupiter-system';
import { marsSystemEntities } from './mars-system';
import { neptuneSystemEntities } from './neptune-system';
import { saturnSystemEntities } from './saturn-system';
import { smallBodyEntities } from './small-bodies';
import { uranusSystemEntities } from './uranus-system';

// 太陽系の CelestialSystem を組む。originId は ECI の中心天体(ステージの選択)、
// earthSpinPhase0 は地球の自転初期位相 [rad]。absoluteSource を渡すと、その有効期間だけ
// 高精度暦パック経路を通る(epochJdTdb はそのパックの元期)。
export function solarSystem(
  originId: SolarSystemId, phases: PhaseOffsets, earthSpinPhase0: number,
  absoluteSource: AbsoluteEphemeris | null, epochOffsetSec: number, epochJdTdb: number,
): CelestialSystem {
  const m = solarSystemMotions(originId, phases, epochOffsetSec, absoluteSource, epochJdTdb);
  // Record の網羅性検査が「physics 側に居る天体に見た目が無い」をコンパイルエラーにする。
  const e: Record<SolarSystemId, CelestialEntity> = {
    sun: new Sun(m.sun, '太陽'),
    ...earthSystemEntities(m.earthSystem, earthSpinPhase0),
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
