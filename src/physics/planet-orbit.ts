// 惑星: その惑星と衛星の共通重心が太陽まわりに描くケプラー軌道。惑星本体ではなく重心が
// ケプラー軌道に乗る(地球は月に対し 1:81 と十分に軽くはなく、重心のまわりを 4,673 km の
// 振幅で回っている)。要素の永年変化は他惑星からの摂動に由来し、世紀あたりの値で入力する。
import { JULIAN_CENTURY, KeplerOrbit } from './kepler-orbit';

export type PlanetOrbit = KeplerOrbit;

const DEG = Math.PI / 180;
const AU = 1.495978707e11; // [m]

// 度・世紀単位で入力された惑星-衛星系重心の軌道要素を、KeplerOrbit のラジアン・秒単位へ変換する。
export function planetOrbit(p: {
  a: number;
  e: number;
  incDeg: number;
  raanDeg: number;
  lonPeriDeg: number;
  l0Deg: number;
  periodSec: number;
  raanRateDegPerCentury: number;
  incRateDegPerCentury: number;
  lonPeriRateDegPerCentury: number;
  eRatePerCentury: number;
  aRatePerCenturyAu: number;
}): PlanetOrbit {
  // 度/世紀・au/世紀の入力単位を、KeplerOrbit のラジアン/秒単位へ一括変換するだけ。
  return {
    a: p.a,
    aRate: (p.aRatePerCenturyAu * AU) / JULIAN_CENTURY,
    e: p.e,
    eRate: p.eRatePerCentury / JULIAN_CENTURY,
    inc: p.incDeg * DEG,
    incRate: (p.incRateDegPerCentury * DEG) / JULIAN_CENTURY,
    raan0: p.raanDeg * DEG,
    raanRate: (p.raanRateDegPerCentury * DEG) / JULIAN_CENTURY,
    lonPeri0: p.lonPeriDeg * DEG,
    lonPeriRate: (p.lonPeriRateDegPerCentury * DEG) / JULIAN_CENTURY,
    l0: p.l0Deg * DEG,
    lRate: (2 * Math.PI) / p.periodSec,
  };
}

export type PlanetAngles = {
  readonly meanAnomaly: number; // [rad]
  readonly meanLongitude: number; // [rad]
  readonly meanAnomalyRate: number; // [rad/s]
  readonly meanLongitudeRate: number; // [rad/s]
};

// 衛星モデルが太陽方向を求めるのに要る角度。惑星-衛星系重心の軌道から取れるので循環しない。
export function planetAngles(orbit: PlanetOrbit, t: number, phaseOffset: number): PlanetAngles {
  const lonPeri = orbit.lonPeri0 + orbit.lonPeriRate * t;
  const meanLongitude = orbit.l0 + phaseOffset + orbit.lRate * t;
  return {
    meanAnomaly: meanLongitude - lonPeri,
    meanLongitude,
    meanAnomalyRate: orbit.lRate - orbit.lonPeriRate,
    meanLongitudeRate: orbit.lRate,
  };
}
