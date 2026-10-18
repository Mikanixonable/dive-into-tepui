// 操作対象から警報の測定値を取り出す。
import { MAX_HULL_TEMP } from '../dynamic/dynamic-entity/combat-ship-entity';
import { MAX_DYN_PRESSURE } from '../player/aero-load';
import { isModularShip } from '../ship/modular-ship';
import type { Controllable } from '../dynamic/dynamic-entity/controllable';
import type { AlarmMeasurements } from './alarm-evaluator';

// controlled の警報の測定値。操作対象が無ければ null。
export function measureAlarms(controlled: Controllable | null): AlarmMeasurements | null {
  if (controlled === null) return null;
  const { fire, altitudeAlarm } = controlled;
  const altitude = altitudeAlarm?.smoothedAltitudeM ?? null;
  return {
    temperatureK: controlled.motion.temperature,
    maxTemperatureK: MAX_HULL_TEMP,
    dynamicPressurePa: isModularShip(controlled) ? controlled.motion.aero.qdyn : null,
    maxDynamicPressurePa: MAX_DYN_PRESSURE,
    fuel: controlled.totalFuel,
    maxFuel: controlled.totalMaxFuel,
    ammo: fire === null ? null : { roundsInMag: fire.rounds, magsLeft: fire.mags },
    altitude: altitudeAlarm === null || altitude === null ? null : {
      meters: altitude,
      descentRateMps: altitudeAlarm.smoothedAltitudeRateMps,
      descending: altitudeAlarm.descendWarned,
    },
  };
}
