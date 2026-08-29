// 土星系(土星と15個の衛星)。静的事実・運動・見た目を1体につき1箇所で組む。
import saturnTextureUrl from '../../../assets/2k_saturn.jpg';
import titanTextureUrl from '../../../assets/2k_titan.jpg';
import { OriginCenteredEphemeris } from '../../../physics/absolute-ephemeris';
import {
  EciOrigin, PhaseOffsets, PlanetDef, PlanetMotion, SatelliteDef, SatelliteMotion, StarMotion,
} from '../../../physics/celestial-motion';
import { AU, planetOrbit } from '../../../physics/planet-orbit';
import { MU_SATURN } from './constants';
import { CelestialSurface } from '../../../render/celestial-surface';
import type { CelestialTexture } from '../../../render/celestial-textures';
import type { CelestialEntity } from '../celestial-entity/celestial-entity';
import { PointEntity } from '../celestial-entity/point-entity';
import { SphereEntity } from '../celestial-entity/sphere-entity';
import { SATURN_LAPLACE_BASIS, SATURN_POLE } from './poles';
import { SATURN_RINGS } from './rings';
import { jplSatelliteOrbit } from './satellite-orbit-builders';

// 土星系に登録された天体の id。表示名も構築の網羅性もこの集合が決める。
export type SaturnSystemBodyId =
  | 'saturn' | 'pan' | 'daphnis' | 'prometheus' | 'pandora' | 'epimetheus' | 'janus' | 'mimas'
  | 'enceladus' | 'tethys' | 'dione' | 'rhea' | 'titan' | 'hyperion' | 'iapetus' | 'phoebe';

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
const PAN: SatelliteDef = {
  id: 'pan',
  mu: 0.00028e9,
  radius: 1.40e4,
  orbit: jplSatelliteOrbit({ a: 1.336e8, e: 0.000, incDeg: 0.0, periodDays: 0.575051, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: SATURN_LAPLACE_BASIS }),
};

const DAPHNIS: SatelliteDef = {
  id: 'daphnis',
  mu: 0,
  radius: 3.9e3,
  orbit: jplSatelliteOrbit({ a: 1.365e8, e: 0.000, incDeg: 0.0, periodDays: 0.594080, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: SATURN_LAPLACE_BASIS }),
};

const PROMETHEUS: SatelliteDef = {
  id: 'prometheus',
  mu: 0.01071e9,
  radius: 4.31e4,
  orbit: jplSatelliteOrbit({ a: 1.394e8, e: 0.002, incDeg: 0.0, periodDays: 0.615878, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: SATURN_LAPLACE_BASIS }),
};

const PANDORA: SatelliteDef = {
  id: 'pandora',
  mu: 0.00926e9,
  radius: 4.06e4,
  orbit: jplSatelliteOrbit({ a: 1.417e8, e: 0.004, incDeg: 0.0, periodDays: 0.631369, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: SATURN_LAPLACE_BASIS }),
};

const EPIMETHEUS: SatelliteDef = {
  id: 'epimetheus',
  mu: 0.03514e9,
  radius: 5.82e4,
  orbit: jplSatelliteOrbit({ a: 1.514e8, e: 0.020, incDeg: 0.3, periodDays: 0.697012, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: SATURN_LAPLACE_BASIS }),
};

const JANUS: SatelliteDef = {
  id: 'janus',
  mu: 0.12662e9,
  radius: 8.92e4,
  orbit: jplSatelliteOrbit({ a: 1.515e8, e: 0.007, incDeg: 0.2, periodDays: 0.697353, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: SATURN_LAPLACE_BASIS }),
};

// 土星の主要な氷衛星6個(ミマス〜レア)。基準面・出典はここまでの土星衛星と同じ。
const MIMAS: SatelliteDef = {
  id: 'mimas',
  mu: 2.50349e9,
  radius: 1.982e5,
  orbit: jplSatelliteOrbit({ a: 1.860e8, e: 0.020, incDeg: 1.6, periodDays: 0.942422, nodePeriodYears: 0.986, apsisPeriodYears: 0.493, basisToEci: SATURN_LAPLACE_BASIS }),
};

const ENCELADUS: SatelliteDef = {
  id: 'enceladus',
  mu: 7.21037e9,
  radius: 2.521e5,
  orbit: jplSatelliteOrbit({ a: 2.384e8, e: 0.005, incDeg: 0.0, periodDays: 1.370218, nodePeriodYears: 0, apsisPeriodYears: 2.916, basisToEci: SATURN_LAPLACE_BASIS }),
};

const TETHYS: SatelliteDef = {
  id: 'tethys',
  mu: 41.21353e9,
  radius: 5.311e5,
  orbit: jplSatelliteOrbit({ a: 2.950e8, e: 0.001, incDeg: 1.1, periodDays: 1.887802, nodePeriodYears: 4.982, apsisPeriodYears: 0.005, basisToEci: SATURN_LAPLACE_BASIS }),
};

const DIONE: SatelliteDef = {
  id: 'dione',
  mu: 73.11607e9,
  radius: 5.614e5,
  orbit: jplSatelliteOrbit({ a: 3.777e8, e: 0.002, incDeg: 0.0, periodDays: 2.736916, nodePeriodYears: 0, apsisPeriodYears: 11.698, basisToEci: SATURN_LAPLACE_BASIS }),
};

const RHEA: SatelliteDef = {
  id: 'rhea',
  mu: 153.94175e9,
  radius: 7.635e5,
  orbit: jplSatelliteOrbit({ a: 5.272e8, e: 0.001, incDeg: 0.3, periodDays: 4.517503, nodePeriodYears: 35.775, apsisPeriodYears: 33.939, basisToEci: SATURN_LAPLACE_BASIS }),
};

const TITAN: SatelliteDef = {
  id: 'titan',
  mu: 8.9781e12,
  radius: 2.5747e6,
  orbit: jplSatelliteOrbit({ a: 1.22187e9, e: 0.0288, incDeg: 0.35, periodDays: 15.945448, nodePeriodYears: 687.370, apsisPeriodYears: 346.680, basisToEci: SATURN_LAPLACE_BASIS }),
};

// タイタンより遠い土星の不規則衛星寄りの3個。イアペトゥスは軌道傾斜が大きく(基準面から
// 7.6°)、フェーベは傾斜角 90° 超で逆行。出典・歳差周期の扱いはここまでの土星衛星と同じ。
const HYPERION: SatelliteDef = {
  id: 'hyperion',
  mu: 0.37049e9,
  radius: 1.350e5,
  orbit: jplSatelliteOrbit({ a: 1.4815e9, e: 0.105, incDeg: 0.6, periodDays: 21.276658, nodePeriodYears: 0, apsisPeriodYears: 0, basisToEci: SATURN_LAPLACE_BASIS }),
};

// イアペトゥス・フェーベは土星から遠く、局所ラプラス面が内側衛星の面から大きく外れる
// (ラプラス面は内側では親の扁平が、外側では太陽潮汐が支配する)。JPL が公開する
// 傾斜角はそれぞれの局所ラプラス面基準で、その面の極は転記できていないため、黄道面基準の
// 傾斜角(イアペトゥス 17.28°: Wikipedia の軌道要素表)で登録する。
const IAPETUS: SatelliteDef = {
  id: 'iapetus',
  mu: 120.51511e9,
  radius: 7.343e5,
  // 歳差周期は局所ラプラス面まわりの実測値で、黄道極まわりに適用すると別の運動になるため置かない。
  orbit: jplSatelliteOrbit({ a: 3.5617e9, e: 0.028, incDeg: 17.28, periodDays: 79.331002, nodePeriodYears: 0, apsisPeriodYears: 0 }),
};

// フェーベは捕獲された逆行の不規則衛星。JPL の傾斜角 175.2° は黄道基準の値と一致する。
const PHOEBE: SatelliteDef = {
  id: 'phoebe',
  mu: 0.55479e9,
  radius: 1.065e5,
  orbit: jplSatelliteOrbit({ a: 1.29294e10, e: 0.164, incDeg: 175.2, periodDays: 550.303910, nodePeriodYears: 0, apsisPeriodYears: 0 }),
};

// 平均輝度 0.6160(A_B は公表ボンド)。render-lab の土星ケースも同じ測光を読む。
export const SATURN_TEXTURE: CelestialTexture = {
  url: saturnTextureUrl, albedoScale: 0.5552, bondAlbedo: 0.342, averageHue: [1.2028, 0.9763, 0.6378],
};

// 土星系の天体の表示名。
export const SATURN_SYSTEM_NAMES: Record<SaturnSystemBodyId, string> = {
  saturn: '土星',
  pan: 'パン',
  daphnis: 'ダフニス',
  prometheus: 'プロメテウス',
  pandora: 'パンドラ',
  epimetheus: 'エピメテウス',
  janus: 'ヤヌス',
  mimas: 'ミマス',
  enceladus: 'エンケラドゥス',
  tethys: 'テティス',
  dione: 'ディオネ',
  rhea: 'レア',
  titan: 'タイタン',
  hyperion: 'ヒペリオン',
  iapetus: 'イアペトゥス',
  phoebe: 'フェーベ',
};

// 土星系を組む。宣言順がそのまま重力源配列・一覧の順序になる。
export function saturnSystem(
  sun: StarMotion, phases: PhaseOffsets, epochOffsetSec: number,
  pack: OriginCenteredEphemeris | null, origin: EciOrigin,
): Record<SaturnSystemBodyId, CelestialEntity> {
  const saturn = new PlanetMotion(SATURN, sun, phases[SATURN.id] ?? 0, epochOffsetSec, pack, origin);
  return {
    // 惑星は戦闘ビューでは輝点スプライトとして描くので PointEntity。
    saturn: new PointEntity(saturn, SATURN_SYSTEM_NAMES.saturn, 'planet', CelestialSurface.textured(SATURN_TEXTURE)),
    // パン A_B=0.28(幾何 0.5 x q=0.564)
    pan: new SphereEntity(
      new SatelliteMotion(PAN, saturn, phases[PAN.id] ?? 0, epochOffsetSec, pack, origin),
      SATURN_SYSTEM_NAMES.pan, 'satellite', CelestialSurface.solid([0.3326, 0.2699, 0.2252]),
    ),
    // ダフニス A_B=0.28(分類既定 幾何 0.5 x q=0.564)
    daphnis: new SphereEntity(
      new SatelliteMotion(DAPHNIS, saturn, phases[DAPHNIS.id] ?? 0, epochOffsetSec, pack, origin),
      SATURN_SYSTEM_NAMES.daphnis, 'satellite', CelestialSurface.solid([0.3326, 0.2699, 0.2252]),
    ),
    // プロメテウス A_B=0.34(幾何 0.6 x q=0.564)
    prometheus: new SphereEntity(
      new SatelliteMotion(PROMETHEUS, saturn, phases[PROMETHEUS.id] ?? 0, epochOffsetSec, pack, origin),
      SATURN_SYSTEM_NAMES.prometheus, 'satellite', CelestialSurface.solid([0.3956, 0.3294, 0.2814]),
    ),
    // パンドラ A_B=0.34(幾何 0.6 x q=0.564)
    pandora: new SphereEntity(
      new SatelliteMotion(PANDORA, saturn, phases[PANDORA.id] ?? 0, epochOffsetSec, pack, origin),
      SATURN_SYSTEM_NAMES.pandora, 'satellite', CelestialSurface.solid([0.3956, 0.3294, 0.2814]),
    ),
    // エピメテウス A_B=0.41(幾何 0.73 x q=0.564)
    epimetheus: new SphereEntity(
      new SatelliteMotion(EPIMETHEUS, saturn, phases[EPIMETHEUS.id] ?? 0, epochOffsetSec, pack, origin),
      SATURN_SYSTEM_NAMES.epimetheus, 'satellite', CelestialSurface.solid([0.4694, 0.3987, 0.3469]),
    ),
    // ヤヌス A_B=0.4(幾何 0.71 x q=0.564)
    janus: new SphereEntity(
      new SatelliteMotion(JANUS, saturn, phases[JANUS.id] ?? 0, epochOffsetSec, pack, origin),
      SATURN_SYSTEM_NAMES.janus, 'satellite', CelestialSurface.solid([0.4580, 0.3890, 0.3385]),
    ),
    // ミマス A_B=0.54(幾何 0.962 x q=0.564)
    mimas: new SphereEntity(
      new SatelliteMotion(MIMAS, saturn, phases[MIMAS.id] ?? 0, epochOffsetSec, pack, origin),
      SATURN_SYSTEM_NAMES.mimas, 'satellite', CelestialSurface.solid([0.5631, 0.5382, 0.4903]),
    ),
    // エンケラドゥス A_B=0.81(公表ボンド 0.81(幾何は 1.375))
    enceladus: new SphereEntity(
      new SatelliteMotion(ENCELADUS, saturn, phases[ENCELADUS.id] ?? 0, epochOffsetSec, pack, origin),
      SATURN_SYSTEM_NAMES.enceladus, 'satellite', CelestialSurface.solid([0.8249, 0.8089, 0.7774]),
    ),
    // テティス A_B=0.69(幾何 1.229 x q=0.564)
    tethys: new SphereEntity(
      new SatelliteMotion(TETHYS, saturn, phases[TETHYS.id] ?? 0, epochOffsetSec, pack, origin),
      SATURN_SYSTEM_NAMES.tethys, 'satellite', CelestialSurface.solid([0.7185, 0.6877, 0.6284]),
    ),
    // ディオネ A_B=0.56(幾何 0.998 x q=0.564)
    dione: new SphereEntity(
      new SatelliteMotion(DIONE, saturn, phases[DIONE.id] ?? 0, epochOffsetSec, pack, origin),
      SATURN_SYSTEM_NAMES.dione, 'satellite', CelestialSurface.solid([0.5844, 0.5580, 0.5074]),
    ),
    // レア A_B=0.54(幾何 0.949 x q=0.564)
    rhea: new SphereEntity(
      new SatelliteMotion(RHEA, saturn, phases[RHEA.id] ?? 0, epochOffsetSec, pack, origin),
      SATURN_SYSTEM_NAMES.rhea, 'satellite', CelestialSurface.solid([0.5622, 0.5382, 0.4920]),
    ),
    titan: new SphereEntity(
      new SatelliteMotion(TITAN, saturn, phases[TITAN.id] ?? 0, epochOffsetSec, pack, origin),
      SATURN_SYSTEM_NAMES.titan, 'satellite',
      // 平均輝度 0.2425(A_B は幾何 0.22 x q=0.564)
      CelestialSurface.textured({ url: titanTextureUrl, albedoScale: 0.5113, bondAlbedo: 0.124, averageHue: [1, 1, 1] }),
    ),
    // ヒペリオン A_B=0.14(幾何 0.30 x q=0.461)
    hyperion: new SphereEntity(
      new SatelliteMotion(HYPERION, saturn, phases[HYPERION.id] ?? 0, epochOffsetSec, pack, origin),
      SATURN_SYSTEM_NAMES.hyperion, 'satellite', CelestialSurface.solid([0.1617, 0.1375, 0.1009]),
    ),
    // イアペトゥス A_B=0.12(幾何は明暗半球で 0.05-0.5。全球平均 0.27 x q=0.461)
    iapetus: new SphereEntity(
      new SatelliteMotion(IAPETUS, saturn, phases[IAPETUS.id] ?? 0, epochOffsetSec, pack, origin),
      SATURN_SYSTEM_NAMES.iapetus, 'satellite', CelestialSurface.solid([0.1296, 0.1189, 0.1023]),
    ),
    // フェーベ A_B=0.024(幾何 0.06 x q=0.393)
    phoebe: new SphereEntity(
      new SatelliteMotion(PHOEBE, saturn, phases[PHOEBE.id] ?? 0, epochOffsetSec, pack, origin),
      SATURN_SYSTEM_NAMES.phoebe, 'satellite', CelestialSurface.solid([0.0276, 0.0234, 0.0196]),
    ),
  };
}
