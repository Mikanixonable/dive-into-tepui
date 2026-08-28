// 土星と15個の衛星の静的事実と、その運動を組む構築関数。
import { OriginCenteredEphemeris } from '../absolute-ephemeris';
import {
  EciOrigin, PhaseOffsets, PlanetDef, PlanetMotion, SatelliteDef, SatelliteMotion, StarMotion,
} from '../celestial-motion';
import { AU, planetOrbit } from '../planet-orbit';
import { MU_SATURN } from './constants';
import { SATURN_LAPLACE_BASIS, SATURN_POLE } from './poles';
import { SATURN_RINGS } from './rings';
import { jplSatelliteOrbit } from './satellite-orbit-builders';

export const SATURN: PlanetDef = {
  id: 'saturn',
  mu: MU_SATURN,
  radius: 6.0268e7, // 赤道半径(外接球)。出典: pck00011.tpc BODY_RADII
  shape: { kind: 'spheroid', equatorRadius: 6.0268e7, polarRadius: 5.4364e7 },
  lagrangeLabels: true,
  orbit: planetOrbit({
    a: 9.53667594 * AU,
    e: 0.05386179,
    incDeg: 2.48599187,
    raanDeg: 113.66242448,
    lonPeriDeg: 92.59887831,
    l0Deg: 49.95424423,
    lRateDegPerCentury: 1222.49362201,
    raanRateDegPerCentury: -0.28867794,
    incRateDegPerCentury: 0.00193609,
    lonPeriRateDegPerCentury: -0.41897216,
    eRatePerCentury: -0.00050991,
    aRatePerCenturyAu: -0.00125060,
  }),
  pole: SATURN_POLE,
  rings: SATURN_RINGS,
};

// 土星の輪の近くを回る羊飼い衛星・環境軌道衛星6個。基準面はタイタンと同じ土星系
// ラプラス面。GM・平均半径は JPL Planetary Satellite Physical Parameters。歳差周期は
// いずれも未測定。ダフニスのみ GM が未測定(mu: 0)で、半径も同表に無いため Wikipedia
// "Daphnis (moon)"(平均直径 7.8±1.0 km、一次は測光サイズ推定)の値を使う。
export const PAN: SatelliteDef = {
  id: 'pan',
  mu: 0.00028e9,
  radius: 1.40e4,
  orbit: jplSatelliteOrbit({ a: 1.336e8, e: 0.000, incDeg: 0.0, periodDays: 0.575051, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: SATURN_LAPLACE_BASIS }),
};

export const DAPHNIS: SatelliteDef = {
  id: 'daphnis',
  mu: 0,
  radius: 3.9e3,
  orbit: jplSatelliteOrbit({ a: 1.365e8, e: 0.000, incDeg: 0.0, periodDays: 0.594080, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: SATURN_LAPLACE_BASIS }),
};

export const PROMETHEUS: SatelliteDef = {
  id: 'prometheus',
  mu: 0.01071e9,
  radius: 4.31e4,
  orbit: jplSatelliteOrbit({ a: 1.394e8, e: 0.002, incDeg: 0.0, periodDays: 0.615878, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: SATURN_LAPLACE_BASIS }),
};

export const PANDORA: SatelliteDef = {
  id: 'pandora',
  mu: 0.00926e9,
  radius: 4.06e4,
  orbit: jplSatelliteOrbit({ a: 1.417e8, e: 0.004, incDeg: 0.0, periodDays: 0.631369, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: SATURN_LAPLACE_BASIS }),
};

export const EPIMETHEUS: SatelliteDef = {
  id: 'epimetheus',
  mu: 0.03514e9,
  radius: 5.82e4,
  orbit: jplSatelliteOrbit({ a: 1.514e8, e: 0.020, incDeg: 0.3, periodDays: 0.697012, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: SATURN_LAPLACE_BASIS }),
};

export const JANUS: SatelliteDef = {
  id: 'janus',
  mu: 0.12662e9,
  radius: 8.92e4,
  orbit: jplSatelliteOrbit({ a: 1.515e8, e: 0.007, incDeg: 0.2, periodDays: 0.697353, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: SATURN_LAPLACE_BASIS }),
};

// 土星の主要な氷衛星6個(ミマス〜レア)。基準面・出典はここまでの土星衛星と同じ。
export const MIMAS: SatelliteDef = {
  id: 'mimas',
  mu: 2.50349e9,
  radius: 1.982e5,
  orbit: jplSatelliteOrbit({ a: 1.860e8, e: 0.020, incDeg: 1.6, periodDays: 0.942422, nodePeriodYears: 0.986, apsisPeriodYears: 0.493, basisToEci: SATURN_LAPLACE_BASIS }),
};

export const ENCELADUS: SatelliteDef = {
  id: 'enceladus',
  mu: 7.21037e9,
  radius: 2.521e5,
  orbit: jplSatelliteOrbit({ a: 2.384e8, e: 0.005, incDeg: 0.0, periodDays: 1.370218, nodePeriodYears: 0, apsisPeriodYears: 2.916, basisToEci: SATURN_LAPLACE_BASIS }),
};

export const TETHYS: SatelliteDef = {
  id: 'tethys',
  mu: 41.21353e9,
  radius: 5.311e5,
  orbit: jplSatelliteOrbit({ a: 2.950e8, e: 0.001, incDeg: 1.1, periodDays: 1.887802, nodePeriodYears: 4.982, apsisPeriodYears: 0.005, basisToEci: SATURN_LAPLACE_BASIS }),
};

export const DIONE: SatelliteDef = {
  id: 'dione',
  mu: 73.11607e9,
  radius: 5.614e5,
  orbit: jplSatelliteOrbit({ a: 3.777e8, e: 0.002, incDeg: 0.0, periodDays: 2.736916, nodePeriodYears: 0, apsisPeriodYears: 11.698, basisToEci: SATURN_LAPLACE_BASIS }),
};

export const RHEA: SatelliteDef = {
  id: 'rhea',
  mu: 153.94175e9,
  radius: 7.635e5,
  orbit: jplSatelliteOrbit({ a: 5.272e8, e: 0.001, incDeg: 0.3, periodDays: 4.517503, nodePeriodYears: 35.775, apsisPeriodYears: 33.939, basisToEci: SATURN_LAPLACE_BASIS }),
};

export const TITAN: SatelliteDef = {
  id: 'titan',
  mu: 8.9781e12,
  radius: 2.5747e6,
  orbit: jplSatelliteOrbit({ a: 1.22187e9, e: 0.0288, incDeg: 0.35, periodDays: 15.945448, nodePeriodYears: 687.370, apsisPeriodYears: 346.680, basisToEci: SATURN_LAPLACE_BASIS }),
};

// タイタンより遠い土星の不規則衛星寄りの3個。イアペトゥスは軌道傾斜が大きく(基準面から
// 7.6°)、フェーベは傾斜角 90° 超で逆行。出典・歳差周期の扱いはここまでの土星衛星と同じ。
export const HYPERION: SatelliteDef = {
  id: 'hyperion',
  mu: 0.37049e9,
  radius: 1.350e5,
  orbit: jplSatelliteOrbit({ a: 1.4815e9, e: 0.105, incDeg: 0.6, periodDays: 21.276658, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: SATURN_LAPLACE_BASIS }),
};

// イアペトゥス・フェーベは土星から遠く、局所ラプラス面が内側衛星の面から大きく外れる
// (ラプラス面は内側では親の扁平が、外側では太陽潮汐が支配する)。JPL が公開する
// 傾斜角はそれぞれの局所ラプラス面基準で、その面の極は転記できていないため、黄道面基準の
// 傾斜角(イアペトゥス 17.28°: Wikipedia の軌道要素表)で登録する。
export const IAPETUS: SatelliteDef = {
  id: 'iapetus',
  mu: 120.51511e9,
  radius: 7.343e5,
  // 歳差周期は局所ラプラス面まわりの実測値で、黄道極まわりに適用すると別の運動になるため置かない。
  orbit: jplSatelliteOrbit({ a: 3.5617e9, e: 0.028, incDeg: 17.28, periodDays: 79.331002, nodePeriodYears: 0, apsisPeriodYears: 0 }),
};

// フェーベは捕獲された逆行の不規則衛星。JPL の傾斜角 175.2° は黄道基準の値と一致する。
export const PHOEBE: SatelliteDef = {
  id: 'phoebe',
  mu: 0.55479e9,
  radius: 1.065e5,
  orbit: jplSatelliteOrbit({ a: 1.29294e10, e: 0.164, incDeg: 175.2, periodDays: 550.303910, nodePeriodYears: 0, apsisPeriodYears: 0 }),
};

export type SaturnSystemMotions = {
  readonly saturn: PlanetMotion;
  readonly pan: SatelliteMotion;
  readonly daphnis: SatelliteMotion;
  readonly prometheus: SatelliteMotion;
  readonly pandora: SatelliteMotion;
  readonly epimetheus: SatelliteMotion;
  readonly janus: SatelliteMotion;
  readonly mimas: SatelliteMotion;
  readonly enceladus: SatelliteMotion;
  readonly tethys: SatelliteMotion;
  readonly dione: SatelliteMotion;
  readonly rhea: SatelliteMotion;
  readonly titan: SatelliteMotion;
  readonly hyperion: SatelliteMotion;
  readonly iapetus: SatelliteMotion;
  readonly phoebe: SatelliteMotion;
};

// 土星と15個の衛星の運動を組む。
export function saturnSystem(
  sun: StarMotion, phases: PhaseOffsets, epochOffsetSec: number,
  pack: OriginCenteredEphemeris | null, origin: EciOrigin,
): SaturnSystemMotions {
  const saturn = new PlanetMotion(SATURN, sun, phases[SATURN.id] ?? 0, epochOffsetSec, pack, origin);
  const pan = new SatelliteMotion(PAN, saturn, phases[PAN.id] ?? 0, epochOffsetSec, pack, origin);
  const daphnis = new SatelliteMotion(DAPHNIS, saturn, phases[DAPHNIS.id] ?? 0, epochOffsetSec, pack, origin);
  const prometheus = new SatelliteMotion(PROMETHEUS, saturn, phases[PROMETHEUS.id] ?? 0, epochOffsetSec, pack, origin);
  const pandora = new SatelliteMotion(PANDORA, saturn, phases[PANDORA.id] ?? 0, epochOffsetSec, pack, origin);
  const epimetheus = new SatelliteMotion(EPIMETHEUS, saturn, phases[EPIMETHEUS.id] ?? 0, epochOffsetSec, pack, origin);
  const janus = new SatelliteMotion(JANUS, saturn, phases[JANUS.id] ?? 0, epochOffsetSec, pack, origin);
  const mimas = new SatelliteMotion(MIMAS, saturn, phases[MIMAS.id] ?? 0, epochOffsetSec, pack, origin);
  const enceladus = new SatelliteMotion(ENCELADUS, saturn, phases[ENCELADUS.id] ?? 0, epochOffsetSec, pack, origin);
  const tethys = new SatelliteMotion(TETHYS, saturn, phases[TETHYS.id] ?? 0, epochOffsetSec, pack, origin);
  const dione = new SatelliteMotion(DIONE, saturn, phases[DIONE.id] ?? 0, epochOffsetSec, pack, origin);
  const rhea = new SatelliteMotion(RHEA, saturn, phases[RHEA.id] ?? 0, epochOffsetSec, pack, origin);
  const titan = new SatelliteMotion(TITAN, saturn, phases[TITAN.id] ?? 0, epochOffsetSec, pack, origin);
  const hyperion = new SatelliteMotion(HYPERION, saturn, phases[HYPERION.id] ?? 0, epochOffsetSec, pack, origin);
  const iapetus = new SatelliteMotion(IAPETUS, saturn, phases[IAPETUS.id] ?? 0, epochOffsetSec, pack, origin);
  const phoebe = new SatelliteMotion(PHOEBE, saturn, phases[PHOEBE.id] ?? 0, epochOffsetSec, pack, origin);
  return {
    saturn, pan, daphnis, prometheus, pandora, epimetheus, janus, mimas, enceladus, tethys, dione, rhea, titan,
    hyperion, iapetus, phoebe,
  };
}
