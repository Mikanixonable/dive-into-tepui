// 現実の太陽系の game 側パック: physics 側パック(solarSystemMotions)が組んだ運動に
// 見た目(CelestialEntity)を対応づけ、CelestialSystem を返す構築コードの入口。
import { AbsoluteEphemeris } from '../../../physics/absolute-ephemeris';
import { PhaseOffsets } from '../../../physics/celestial-motion';
import {
  SolarSystemId, solarSystemMotions,
} from '../../../physics/solar-system/solar-system';
import { CELESTIAL_APPEARANCES, fallbackCelestialAppearance } from '../celestial-appearance';
import { CelestialSystem } from '../celestial-system';
import type { CelestialEntity } from '../celestial-entity';
import { Sun } from '../sun';
import { earthSystemEntities } from './earth-system';

// 太陽系の CelestialSystem を組む。originId は ECI の中心天体(ステージの選択)、
// earthSpinPhase0 は地球の自転初期位相 [rad]。absoluteSource を渡すと、その有効期間だけ
// 高精度暦パック経路を通る(epochJdTdb はそのパックの元期)。
export function solarSystem(
  originId: SolarSystemId, phases: PhaseOffsets, earthSpinPhase0: number,
  absoluteSource: AbsoluteEphemeris | null, epochOffsetSec: number, epochJdTdb: number,
): CelestialSystem {
  const m = solarSystemMotions(originId, phases, epochOffsetSec, absoluteSource, epochJdTdb);
  const e: Partial<Record<string, CelestialEntity>> = {
    sun: new Sun(m.sun, '太陽'),
    ...earthSystemEntities(m.earthSystem, earthSpinPhase0),
  };
  const bodies = m.all.map((motion) => (
    e[motion.id]
    ?? (motion.id in CELESTIAL_APPEARANCES
      ? CELESTIAL_APPEARANCES[motion.id as SolarSystemId].create(motion)
      : fallbackCelestialAppearance(motion))
  ));
  const origin = bodies.find((b) => b.id === originId);
  if (origin === undefined) throw new Error(`solarSystem: 原点天体が見つからない: ${originId}`);
  return new CelestialSystem(bodies, origin, phases);
}
