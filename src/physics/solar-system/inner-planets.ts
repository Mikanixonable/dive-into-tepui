// 水星・金星の静的事実と、その運動を組む構築関数。
import { OriginCenteredEphemeris } from '../absolute-ephemeris';
import { EciOrigin, PhaseOffsets, PlanetDef, PlanetMotion, StarMotion } from '../celestial-motion';
import { AU, planetOrbit } from '../planet-orbit';

// 水星〜海王星の要素・永年変化率はいずれも JPL Standish "Keplerian Elements for Approximate
// Positions of the Major Planets" Table 1(黄道基準・J2000、有効期間 1800–2050AD)。
export const MERCURY: PlanetDef = {
  id: 'mercury',
  mu: 2.2032e13,
  radius: 2.44053e6, // 赤道半径(外接球)。出典: pck00011.tpc BODY_RADII
  shape: { kind: 'spheroid', equatorRadius: 2.44053e6, polarRadius: 2.43826e6 },
  // ϖ̇ の 0.16047689 deg/Cy = 577.7″/Cy には一般相対論による近日点移動 42.98″/Cy が既に
  // 含まれている(この表は PPN 相対論込みで数値積分された JPL DE 暦へのフィット)。
  // 惑星摂動のみの古典値 531.6″/Cy に補正項を足す形にしてはならない。
  orbit: planetOrbit({
    a: 0.38709927 * AU,
    e: 0.20563593,
    incDeg: 7.00497902,
    raanDeg: 48.33076593,
    lonPeriDeg: 77.45779628,
    l0Deg: 252.25032350,
    lRateDegPerCentury: 149472.67411175,
    raanRateDegPerCentury: -0.12534081,
    incRateDegPerCentury: -0.00594749,
    lonPeriRateDegPerCentury: 0.16047689,
    eRatePerCentury: 0.00001906,
    aRatePerCenturyAu: 0.00000037,
  }),
  pole: {
    kind: 'iau',
    ra0Deg: 281.0103,
    ra1DegPerCentury: -0.0328,
    dec0Deg: 61.4155,
    dec1DegPerCentury: -0.0049,
    w0Deg: 329.5988,
    wRateDegPerDay: 6.1385108,
  },
};

export const VENUS: PlanetDef = {
  id: 'venus',
  mu: 3.24859e14,
  radius: 6.0518e6, // 扁平率 0(pck00011.tpc BODY_RADII は赤道・極とも等値)なので shape なし
  orbit: planetOrbit({
    a: 0.72333566 * AU,
    e: 0.00677672,
    incDeg: 3.39467605,
    raanDeg: 76.67984255,
    lonPeriDeg: 131.60246718,
    l0Deg: 181.97909950,
    lRateDegPerCentury: 58517.81538729,
    raanRateDegPerCentury: -0.27769418,
    incRateDegPerCentury: -0.00078890,
    lonPeriRateDegPerCentury: 0.00268329,
    eRatePerCentury: -0.00004107,
    aRatePerCenturyAu: 0.00000390,
  }),
  pole: {
    kind: 'iau',
    ra0Deg: 272.76,
    ra1DegPerCentury: 0.0,
    dec0Deg: 67.16,
    dec1DegPerCentury: 0.0,
    w0Deg: 160.2,
    wRateDegPerDay: -1.4813688,
  },
};

export type InnerPlanetMotions = {
  readonly mercury: PlanetMotion;
  readonly venus: PlanetMotion;
};

// 水星・金星の運動を組む。
export function innerPlanets(
  sun: StarMotion, phases: PhaseOffsets, epochOffsetSec: number,
  pack: OriginCenteredEphemeris | null, origin: EciOrigin,
): InnerPlanetMotions {
  const mercury = new PlanetMotion(MERCURY, sun, phases[MERCURY.id] ?? 0, epochOffsetSec, pack, origin);
  const venus = new PlanetMotion(VENUS, sun, phases[VENUS.id] ?? 0, epochOffsetSec, pack, origin);
  return { mercury, venus };
}
