// 内惑星(水星・金星)。静的事実・運動・見た目を1体につき1箇所で組む。
import mercuryTextureUrl from '../../../assets/2k_mercury.jpg';
import venusTextureUrl from '../../../assets/2k_venus_atmosphere.jpg';
import { PhaseOffsets, PlanetDef, planetDefForSimZero, StarMotion } from '../../../physics/celestial-motion';
import { planetSystem } from '../../../physics/planet-system';
import { planetOrbit } from '../../../physics/kepler-orbit';
import { AU } from '../../../physics/astronomical-unit';
import { CelestialSurface } from '../../../render/celestial-surface';
import type { CelestialEntity } from '../celestial-entity/celestial-entity';
import { PointEntity } from '../celestial-entity/point-entity';

// 内惑星に登録された天体の id。表示名も構築の網羅性もこの集合が決める。
export type InnerPlanetId = 'mercury' | 'venus';

// 水星〜海王星の要素・永年変化率はいずれも JPL Standish "Keplerian Elements for Approximate
// Positions of the Major Planets" Table 1(黄道基準・J2000、有効期間 1800–2050AD)。
const MERCURY: PlanetDef = {
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

// 内惑星の表示名。
export const INNER_PLANET_NAMES: Record<InnerPlanetId, string> = {
  mercury: '水星',
  venus: '金星',
};

// 内惑星を組む。宣言順がそのまま重力源配列・一覧の順序になる。
export function innerPlanets(
  sun: StarMotion, phases: PhaseOffsets, simZeroEt: number,
): Record<InnerPlanetId, CelestialEntity> {
  return {
    mercury: new PointEntity(
      planetSystem(planetDefForSimZero(MERCURY, phases, simZeroEt), sun).body,
      INNER_PLANET_NAMES.mercury, 'planet',
      // 平均輝度 0.2306(A_B は公表ボンド)
      CelestialSurface.textured({ url: mercuryTextureUrl, albedoScale: 0.3815, bondAlbedo: 0.088, averageHue: [1.0088, 0.9974, 0.9997] }),
    ),
    venus: new PointEntity(
      planetSystem(planetDefForSimZero(VENUS, phases, simZeroEt), sun).body,
      INNER_PLANET_NAMES.venus, 'planet',
      // 平均輝度 0.5561(A_B は公表ボンド)
      CelestialSurface.textured({ url: venusTextureUrl, albedoScale: 1.3666, bondAlbedo: 0.76, averageHue: [1.4227, 0.9352, 0.3977] }),
    ),
  };
}
