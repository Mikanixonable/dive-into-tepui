// 地球系(地球・月)。静的事実・運動・見た目を1体につき1箇所で組む。
import * as THREE from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import climateTextureUrl from '../../../assets/earth-climate.png';
import cloudFieldUrl from '../../../assets/cloud-field.png';
import moonTextureUrl from '../../../assets/8k_moon.jpg';
import coastlineData from '../../../assets/earth-coastline.json';
import moonFeaturesData from '../../../assets/moon-features.json';
import type { AtmosphereDef } from '../../../physics/atmosphere';
import { SatelliteMotion, type StarMotion } from '../../../physics/celestial-motion';
import { type PlanetDef, planetDefForSimZero, type SatelliteDef, satelliteDefForSimZero } from '../../../physics/celestial-body-def';
import { planetSystem } from '../../../physics/planet-system';
import { planetOrbit } from '../../../physics/kepler-orbit';
import { satelliteOrbit } from '../../../physics/satellite-orbit';
import { Aurora, type AuroraOptics } from '../../../render/celestial/aurora';
import { CelestialSurface } from '../../../render/celestial/celestial-surface';
import { createEarthSurfaceRuntime } from '../../../render/earth-surface-factory';
import { CloudPresentation } from '../../../render/cloud/cloud-presentation';
import { CloudLocalFieldBaker } from '../../../render/cloud/cloud-local-field-baker';
import { GeneratedCloudField } from '../../../render/cloud/generated-cloud-field';
import { ObservedCloudField } from '../../../render/cloud/observed-cloud-field';
import {
  ConvectiveCloudLocalFieldSupply, CONVECTIVE_LOCAL_FIELD_SPAN_M,
} from '../../cloud/cloud-local-field-supply';
import { earthConvectiveCloudEnvironmentAt } from '../../cloud/earth-cloud-environment';
import { AnnualClimateMap } from '../../../render/cloud/climate-map';
import { OrthographicCap, type FieldProjection } from '../../../render/field-projection';
import { CLOUD_CAP_SIZE, CLOUD_CAP_MARGIN } from '../../../render/cloud/cloud-cap';
import { LineOverlay, type LatLonPolyline, type UnitSphereLoop } from '../../../render/celestial/line-overlay';
import { GeostationaryOverlay } from '../../../render/celestial/celestial-entity/geostationary-overlay';
import { PointCelestialView } from '../../../render/celestial/celestial-entity/point-celestial-view';
import { SphereCelestialView } from '../../../render/celestial/celestial-entity/sphere-celestial-view';
import { MOON_DIST_TERMS, MOON_LAT_TERMS, MOON_LON_TERMS } from './moon-terms';
import type { AtmosphereOptics } from '../../../render/atmosphere';
import { CelestialEntity } from '../celestial-entity/celestial-entity';
import { AU } from '../../../physics/astronomical-unit';

// 地球系に登録された天体の id。表示名も構築の網羅性もこの集合が決める。
export type EarthSystemBodyId = 'earth' | 'moon';

export const MU_EARTH = 3.986004418e14; // 地球重力定数 [m^3/s^2]
export const R_EARTH = 6.371e6; // 平均半径 [m]
export const R_EARTH_EQ = 6.378137e6; // 赤道半径 [m]
export const SIDEREAL_DAY = 86164.0905; // 恒星日 [s]
// 2次の重力場係数(非正規化)。正規化係数を収録した外部データで更新する際は換算が要る。
export const J2_EARTH = 1.08262668e-3;

export const MU_MOON = 4.9048695e12; // [m^3/s^2]
export const R_MOON = 1.7374e6; // [m]
// GRAIL による測定値(非正規化)。基準半径 1738.0 km は月の表面半径 R_MOON とは別の量なので分けて持つ。
export const J2_MOON = 203.3e-6;
export const C22_MOON = 22.4e-6;
export const R_MOON_GRAVITY = 1.7380e6; // [m]
// 月の赤道が黄道に対して傾く角(カッシーニ第2法則)。
export const MOON_OBLIQUITY = 1.543 * (Math.PI / 180); // [rad]

// 地球の大気。基準楕円体は海面の回転楕円体(WGS84)で、衝突球の半径(radius)や 2 次重力場の
// 基準半径(refRadius)とは別の理由で選ばれた別の量なので、値が一致していても別に宣言する。
// 層テーブルは Vallado, "Fundamentals of Astrodynamics and Applications" の CIRA-72 /
// U.S. Standard Atmosphere 準拠(高度 0〜1000 km を 28 区間)。
export const EARTH_ATMOSPHERE: AtmosphereDef = {
  equatorRadius: 6.378137e6,
  polarRadius: 6.356752e6,
  spinRate: (2 * Math.PI) / SIDEREAL_DAY,
  layers: [
    [0, 1.225, 7.249e3],
    [25e3, 3.899e-2, 6.349e3],
    [30e3, 1.774e-2, 6.682e3],
    [40e3, 3.972e-3, 7.554e3],
    [50e3, 1.057e-3, 8.382e3],
    [60e3, 3.206e-4, 7.714e3],
    [70e3, 8.77e-5, 6.549e3],
    [80e3, 1.905e-5, 5.799e3],
    [90e3, 3.396e-6, 5.382e3],
    [100e3, 5.297e-7, 5.877e3],
    [110e3, 9.661e-8, 7.263e3],
    [120e3, 2.438e-8, 9.473e3],
    [130e3, 8.484e-9, 12.636e3],
    [140e3, 3.845e-9, 16.149e3],
    [150e3, 2.07e-9, 22.523e3],
    [180e3, 5.464e-10, 29.74e3],
    [200e3, 2.789e-10, 37.105e3],
    [250e3, 7.248e-11, 45.546e3],
    [300e3, 2.418e-11, 53.628e3],
    [350e3, 9.518e-12, 53.298e3],
    [400e3, 3.725e-12, 58.515e3],
    [450e3, 1.585e-12, 60.828e3],
    [500e3, 6.967e-13, 63.822e3],
    [600e3, 1.454e-13, 71.835e3],
    [700e3, 3.614e-14, 88.667e3],
    [800e3, 1.17e-14, 124.64e3],
    [900e3, 5.245e-15, 181.05e3],
    [1000e3, 3.019e-15, 268.0e3],
  ],
};

// 元期での地球の自転位相 [deg]。IAU の自転角 W(出典: pck00011.tpc BODY399_PM の定数項 190.147)は
// 天体赤道と ICRF 赤道の昇交点(赤経 α₀+90°)から測るが、自転軸が ECI の極と重なる地球では交線が
// 定まらず、位相の原点は春分点(赤経 0)になるので 90° ぶん進んだ角になる。
const EARTH_W0_DEG = 190.147 + 90;

export const EARTH: PlanetDef = {
  id: 'earth',
  mu: MU_EARTH,
  // 衝突球・高度基準は赤道半径(外接球)。
  radius: R_EARTH_EQ,
  lagrangeLabels: true,
  // 出典: pck00011.tpc BODY_RADII(Re=6378.1366km, Rp=6356.7519km)。
  shape: { kind: 'spheroid', equatorRadius: R_EARTH_EQ, polarRadius: 6.3567519e6 },
  // JPL 低精度惑星暦の "EM Bary"(地球-月重心)行、黄道基準・J2000 相当。
  orbit: planetOrbit({
    a: 1.00000261 * AU,
    e: 0.01671123,
    incDeg: 0,
    raanDeg: 0,
    lonPeriDeg: 102.93768,
    l0Deg: 100.46457166,
    lRateDegPerCentury: 35999.37244981,
    raanRateDegPerCentury: 0,
    incRateDegPerCentury: -0.01294668,
    lonPeriRateDegPerCentury: 0.32327364,
    eRatePerCentury: -0.00004392,
    aRatePerCenturyAu: 0.00000562,
  }),
  pole: { kind: 'eciPole', spinRate: (2 * Math.PI) / SIDEREAL_DAY, w0Deg: EARTH_W0_DEG },
  // 赤道断面の楕円性 C22 は J2 の約 1/690 しかないため軸対称として扱う。
  degree2: { j2: J2_EARTH, c22: 0, refRadius: R_EARTH_EQ },
  atmosphere: EARTH_ATMOSPHERE,
};

export const MOON: SatelliteDef = {
  id: 'moon',
  mu: MU_MOON,
  radius: R_MOON,
  lagrangeLabels: true,
  orbit: satelliteOrbit({
    a: 3.844e8,
    e: 0.0549,
    incDeg: 5.145,
    raan0Deg: 0,
    lonPeri0Deg: 0,
    l0Deg: 0,
    periodSec: 27.321661 * 86400,
    nodePeriodSec: 18.612958 * 365.25 * 86400,
    perigeePeriodSec: 8.85 * 365.25 * 86400,
    lonTerms: MOON_LON_TERMS,
    latTerms: MOON_LAT_TERMS,
    distTerms: MOON_DIST_TERMS,
  }),
  pole: { kind: 'cassini', obliquity: MOON_OBLIQUITY },
  // J2 に対する C22 の比が地球の約 1/690 に対して約 1/9 と大きく、軸対称近似が成り立たない。
  degree2: { j2: J2_MOON, c22: C22_MOON, refRadius: R_MOON_GRAVITY },
};

// 標準大気の分子散乱と、視程 50km 相当のエーロゾル。
export const EARTH_ATMOSPHERE_OPTICS: AtmosphereOptics = {
  rayleigh: new THREE.Vector3(5.802e-6, 13.558e-6, 33.1e-6),
  rayleighScaleHeight: 8.0e3,
  mie: 3.996e-6,
  mieScaleHeight: 1.2e3,
  mieAnisotropy: 0.8,
  // 中間圏・熱圏の酸素発光をまとめた見えの層。オーロラとは異なり、全球の昼夜境界へ広がる。
  airglow: { color: [0.12, 0.78, 0.36], strength: 1.2e-8, altitude: 95e3, scaleHeight: 8e3 },
};

// 地球へ貼る海岸線。tools/export-coastline.mjs が Natural Earth 110m coastline から焼き込んだ、
// 緯度・経度 [deg] のペアを1本の折れ線として並べた配列の配列。形は焼き込み側が保証するので、
// 型を持たない JSON にここで形を与える。
export const EARTH_COASTLINE = coastlineData as readonly LatLonPolyline[];

// 月へ貼る主要な海・クレーターの輪郭。tools/export-moon-features.mjs が assets-src/moon-features.json
// の中心緯度経度・直径から円として焼き込んだ、単位球面上の xyz を1ループとして並べた配列の配列。
const MOON_SURFACE_MARKINGS = moonFeaturesData as readonly UnitSphereLoop[];

// 地球のオーロラ。オーバル緯度は磁極の配置、発光高度は降り込む粒子が大気を励起する層、
// 色は酸素の緑(557.7nm)と赤(630nm)の輝線による。
const EARTH_AURORA_OPTICS: AuroraOptics = {
  bodyRadius: R_EARTH,
  ovalLatitudeDeg: 66,
  magneticPoleLatitudeDeg: 80.65,
  magneticPoleLongitudeDeg: -72.68,
  baseAltitude: 95e3,
  coreAltitude: 120e3,
  topAltitude: 480e3,
  topAltitudeVariation: 180e3,
  layerColors: [
    [0.0, 0.1, 0.05],
    [0.1, 0.9, 0.4],
    [0.7, 0.15, 0.2],
    [0.1, 0.01, 0.02],
  ],
};

// 地球系の天体の表示名。
export const EARTH_SYSTEM_NAMES: Record<EarthSystemBodyId, string> = {
  earth: '地球',
  moon: '月',
};

// 両極それぞれ2層のカーテン。同じ極の層は geomSeed を揃えて平行にし、半径・緯度・明滅を
// ずらして厚みを出す。
function earthAuroras(): readonly Aurora[] {
  const o = EARTH_AURORA_OPTICS;
  return [
    new Aurora(o, 1, 1.3, 1.3, 0, 0, 0),
    new Aurora(o, 1, 1.3, 2.7, 45e3, 1.5, 1),
    new Aurora(o, -1, 4.1, 4.1, 0, 0, 2),
    new Aurora(o, -1, 4.1, 5.5, 45e3, 1.5, 3),
  ];
}

// 地球の局所雲場の種。セルのポテンシャルとイベント出生の決定論はこれで決まる。
const EARTH_CLOUD_LOCAL_SEED = 41;
// 局所場の再焼を促す視点の移動量 — 場の半幅の 25% [rad]。
const EARTH_LOCAL_FIELD_RECENTER_RAD =
  0.25 * (CONVECTIVE_LOCAL_FIELD_SPAN_M / 2) / R_EARTH_EQ;
// 局所場の再焼間隔 [s]。
const EARTH_LOCAL_FIELD_REBUILD_SECONDS = 300;

// 地球の平年の気候から焼く雲場を組む。projection は場の持ち方。返した場の寿命は受け取った側が持つ。
// **実験環境も本番もこの工場から組む** — 別の組み立てを書くと、実験環境が本番を映さなくなる。
export function earthGeneratedCloudField(projection: FieldProjection): GeneratedCloudField {
  // 気象シミュレーションに適用する半径は、全球を一様な球体とみなす平均半径。
  return new GeneratedCloudField(
    AnnualClimateMap.fromDeferredUrl(climateTextureUrl), projection, R_EARTH, SIDEREAL_DAY,
  );
}

// 地球の雲場ぜんぶを組む。生成と実写を同じ 1 つの cap へ焼き、CloudPresentation がその cap を
// 視点へ置き直す。
export function earthCloudPresentation(): CloudPresentation {
  const cap = new OrthographicCap(CLOUD_CAP_SIZE, 0, 0, CLOUD_CAP_MARGIN);
  // 局所光学場は対流イベントの生成経路から供給する。球の半径は衝突球と同じ赤道半径 —
  // 扁平率ぶんの地表距離の誤差は最大で0.3%程度の近似として扱う。
  const localFieldBaker = new CloudLocalFieldBaker(
    new ConvectiveCloudLocalFieldSupply(
      earthConvectiveCloudEnvironmentAt, EARTH_CLOUD_LOCAL_SEED, R_EARTH_EQ),
    EARTH_LOCAL_FIELD_REBUILD_SECONDS, EARTH_LOCAL_FIELD_RECENTER_RAD);
  return new CloudPresentation(
    earthGeneratedCloudField(cap), new ObservedCloudField(cloudFieldUrl, cap), cap, R_EARTH_EQ,
    localFieldBaker,
  );
}

// 地球系を組む。宣言順がそのまま重力源配列・一覧の順序になる。
export function earthSystem(
  sun: StarMotion, simZeroEt: number, renderer?: WebGPURenderer,
): Record<EarthSystemBodyId, CelestialEntity> {
  const earth = planetSystem(planetDefForSimZero(EARTH, simZeroEt), sun);
  const earthSurfaceRuntime = createEarthSurfaceRuntime({ renderer });
  const cumulus = earthCloudPresentation();
  const earthSurface = earthSurfaceRuntime.surface;
  return {
    earth: new CelestialEntity(
      earth.body, EARTH_SYSTEM_NAMES.earth, 'planet',
      new PointCelestialView(
        earthSurface,
        EARTH_ATMOSPHERE_OPTICS,
        LineOverlay.of({ kind: 'latLonPolylines', polylines: EARTH_COASTLINE }),
        earthAuroras(),
        GeostationaryOverlay.of(earth.body), cumulus,
      ),
    ),
    moon: new CelestialEntity(
      new SatelliteMotion(satelliteDefForSimZero(MOON, simZeroEt), earth),
      EARTH_SYSTEM_NAMES.moon, 'satellite',
      new SphereCelestialView(
        // 倍率はテクスチャの平均輝度 0.3180 を公表のボンドアルベドへ合わせる値。
        CelestialSurface.textured({
          url: moonTextureUrl, albedoScale: 0.3459, bondAlbedo: 0.11, averageHue: [1.0458, 0.9880, 0.9844],
        }),
        null, LineOverlay.of({ kind: 'unitSphereLoops', loops: MOON_SURFACE_MARKINGS }),
      ),
    ),
  };
}
