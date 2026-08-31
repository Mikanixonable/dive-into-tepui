// 天王星系(天王星と6個の衛星)。静的事実・運動・見た目を1体につき1箇所で組む。
import uranusTextureUrl from '../../../assets/2k_uranus.jpg';
import {
  PhaseOffsets, PlanetDef, planetDefForSimZero, SatelliteDef, satelliteDefForSimZero, SatelliteMotion, StarMotion,
} from '../../../physics/celestial-motion';
import { planetSystem } from '../../../physics/planet-system';
import { AU, planetOrbit } from '../../../physics/planet-orbit';
import { GRAVITATIONAL_CONSTANT } from './constants';
import { CelestialSurface } from '../../../render/celestial-surface';
import type { CelestialEntity } from '../celestial-entity/celestial-entity';
import { PointEntity } from '../celestial-entity/point-entity';
import { SphereEntity } from '../celestial-entity/sphere-entity';
import { URANUS_POLE, equatorBasis } from './poles';
import { URANUS_RINGS } from './rings';
import { jplSatelliteOrbit } from './satellite-orbit-builders';

// 天王星系に登録された天体の id。表示名も構築の網羅性もこの集合が決める。
export type UranusSystemBodyId = 'uranus' | 'puck' | 'miranda' | 'ariel' | 'umbriel' | 'titania' | 'oberon';

export const URANUS: PlanetDef = {
  id: 'uranus',
  mu: 5.793939e15,
  radius: 2.55566e7, // 赤道半径(外接球)。出典: pck00011.tpc BODY_RADII
  shape: { kind: 'spheroid', equatorRadius: 2.55566e7, polarRadius: 2.49685e7 },
  orbit: planetOrbit({
    a: 19.18916464 * AU,
    e: 0.04725744,
    incDeg: 0.77263783,
    raanDeg: 74.01692503,
    lonPeriDeg: 170.95427630,
    l0Deg: 313.23810451,
    lRateDegPerCentury: 428.48202785,
    raanRateDegPerCentury: 0.04240589,
    incRateDegPerCentury: -0.00242939,
    lonPeriRateDegPerCentury: 0.40805281,
    eRatePerCentury: -0.00004397,
    aRatePerCenturyAu: -0.00196176,
  }),
  pole: URANUS_POLE,
  rings: URANUS_RINGS,
};

// 天王星の主要衛星6個。基準面は天王星の赤道面(equatorBasis(URANUS_POLE))。
// 出典: JPL Solar System Dynamics 衛星平均要素表 / Planetary Satellite Physical Parameters。
const PUCK: SatelliteDef = {
  id: 'puck',
  // GM は表に無い(6衛星中パックだけ未測定)。半径は Wikipedia "Puck (moon)" 経由
  // (一次は Karkoschka 2001 の Voyager 2 画像解析、平均半径 81±2 km)。質量は
  // この表のミランダが示す密度 1,173 kg/m^3 をその半径に掛けて見積もった。
  mu: GRAVITATIONAL_CONSTANT * 2.61e18,
  radius: 81e3,
  orbit: jplSatelliteOrbit({ a: 86004e3, e: 0.000, incDeg: 0.3, periodDays: 0.761833, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: equatorBasis(URANUS_POLE) }),
};

const MIRANDA: SatelliteDef = {
  id: 'miranda',
  mu: 4.3e9,
  radius: 235.8e3,
  orbit: jplSatelliteOrbit({ a: 129846e3, e: 0.001, incDeg: 4.4, periodDays: 1.413479, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: equatorBasis(URANUS_POLE) }),
};

const ARIEL: SatelliteDef = {
  id: 'ariel',
  mu: 83.5e9,
  radius: 578.9e3,
  orbit: jplSatelliteOrbit({ a: 190929e3, e: 0.001, incDeg: 0.0, periodDays: 2.520379, nodePeriodYears: 0, apsisPeriodYears: 28.901, basisToEci: equatorBasis(URANUS_POLE) }),
};

const UMBRIEL: SatelliteDef = {
  id: 'umbriel',
  mu: 85.1e9,
  radius: 584.7e3,
  orbit: jplSatelliteOrbit({ a: 265986e3, e: 0.004, incDeg: 0.1, periodDays: 4.144177, nodePeriodYears: 129.745, apsisPeriodYears: 64.126, basisToEci: equatorBasis(URANUS_POLE) }),
};

const TITANIA: SatelliteDef = {
  id: 'titania',
  mu: 226.9e9,
  radius: 788.9e3,
  orbit: jplSatelliteOrbit({ a: 436298e3, e: 0.002, incDeg: 0.1, periodDays: 8.705869, nodePeriodYears: 1644.649, apsisPeriodYears: 579.928, basisToEci: equatorBasis(URANUS_POLE) }),
};

const OBERON: SatelliteDef = {
  id: 'oberon',
  mu: 205.3e9,
  radius: 761.4e3,
  orbit: jplSatelliteOrbit({ a: 583511e3, e: 0.002, incDeg: 0.1, periodDays: 13.463237, nodePeriodYears: 192.798, apsisPeriodYears: 158.604, basisToEci: equatorBasis(URANUS_POLE) }),
};

// 天王星系の天体の表示名。
export const URANUS_SYSTEM_NAMES: Record<UranusSystemBodyId, string> = {
  uranus: '天王星',
  puck: 'パック',
  miranda: 'ミランダ',
  ariel: 'アリエル',
  umbriel: 'ウンブリエル',
  titania: 'チタニア',
  oberon: 'オベロン',
};

// 天王星系を組む。宣言順がそのまま重力源配列・一覧の順序になる。
export function uranusSystem(
  sun: StarMotion, phases: PhaseOffsets, simZeroEt: number,
): Record<UranusSystemBodyId, CelestialEntity> {
  const uranus = planetSystem(planetDefForSimZero(URANUS, phases, simZeroEt), sun);
  return {
    uranus: new PointEntity(
      uranus.body, URANUS_SYSTEM_NAMES.uranus, 'planet',
      // 平均輝度 0.5640(A_B は公表ボンド)
      CelestialSurface.textured({ url: uranusTextureUrl, albedoScale: 0.5320, bondAlbedo: 0.3, averageHue: [0.6079, 1.0981, 1.1831] }),
    ),
    puck: new SphereEntity(
      new SatelliteMotion(satelliteDefForSimZero(PUCK, phases, simZeroEt), uranus),
      URANUS_SYSTEM_NAMES.puck, 'satellite',
      // A_B=0.051(幾何 0.11 x q=0.461)
      CelestialSurface.solid([0.0536, 0.0508, 0.0455]),
    ),
    miranda: new SphereEntity(
      new SatelliteMotion(satelliteDefForSimZero(MIRANDA, phases, simZeroEt), uranus),
      URANUS_SYSTEM_NAMES.miranda, 'satellite',
      // A_B=0.18(幾何 0.32 x q=0.564)
      CelestialSurface.solid([0.1875, 0.1791, 0.1668]),
    ),
    ariel: new SphereEntity(
      new SatelliteMotion(satelliteDefForSimZero(ARIEL, phases, simZeroEt), uranus),
      URANUS_SYSTEM_NAMES.ariel, 'satellite',
      // A_B=0.3(幾何 0.53 x q=0.564)
      CelestialSurface.solid([0.3059, 0.2996, 0.2871]),
    ),
    umbriel: new SphereEntity(
      new SatelliteMotion(satelliteDefForSimZero(UMBRIEL, phases, simZeroEt), uranus),
      URANUS_SYSTEM_NAMES.umbriel, 'satellite',
      // A_B=0.15(幾何 0.26 x q=0.564)
      CelestialSurface.solid([0.1562, 0.1490, 0.1420]),
    ),
    titania: new SphereEntity(
      new SatelliteMotion(satelliteDefForSimZero(TITANIA, phases, simZeroEt), uranus),
      URANUS_SYSTEM_NAMES.titania, 'satellite',
      // A_B=0.2(幾何 0.35 x q=0.564)
      CelestialSurface.solid([0.2044, 0.2000, 0.1872]),
    ),
    oberon: new SphereEntity(
      new SatelliteMotion(satelliteDefForSimZero(OBERON, phases, simZeroEt), uranus),
      URANUS_SYSTEM_NAMES.oberon, 'satellite',
      // A_B=0.17(幾何 0.31 x q=0.564)
      CelestialSurface.solid([0.1773, 0.1694, 0.1543]),
    ),
  };
}
