// 地球系(地球・月)。静的事実・運動・見た目を1体につき1箇所で組む。
import * as THREE from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import earthTextureUrl from '../../../assets/earth.jpg';
import moonTextureUrl from '../../../assets/8k_moon.jpg';
import coastlineData from '../../../assets/earth-coastline.json';
import moonFeaturesData from '../../../assets/moon-features.json';
import { AtmosphereDef } from '../../../physics/atmosphere';
import { SatelliteMotion, StarMotion } from '../../../physics/celestial-motion';
import { PhaseOffsets, PlanetDef, planetDefForSimZero, SatelliteDef, satelliteDefForSimZero } from '../../../physics/celestial-body-def';
import { planetSystem } from '../../../physics/planet-system';
import { planetOrbit } from '../../../physics/kepler-orbit';
import { satelliteOrbit } from '../../../physics/satellite-orbit';
import {
  C22_MOON, J2_EARTH, J2_MOON, MOON_OBLIQUITY, MU_EARTH, MU_MOON, R_EARTH, R_EARTH_EQ, R_MOON,
  R_MOON_GRAVITY, SIDEREAL_DAY,
} from './constants';
import { Aurora, type AuroraOptics } from '../../../render/celestial/aurora';
import { CelestialSurface } from '../../../render/celestial/celestial-surface';
import { EarthSurface, EarthSurfaceContext } from '../../../render/earth-surface';
import type { EarthSurfaceMaterialAttachment, EarthSurfaceStatus } from '../../../render/earth-surface';
import { EarthSurfaceResidentCoordinator } from '../../../render/earth-surface-resident';
import type { EarthSurfaceColorToRgba8 } from '../../../render/earth-surface-resident';
import { EarthSurfaceTileRequestQueue } from '../../../render/earth-surface-request';
import { EarthSurfaceTiles } from '../../../render/earth-surface-tiles';
import { EarthSurfaceGpuAdapter } from '../../../render/earth-surface-gpu';
import type { EarthSurfaceGpuTextures } from '../../../render/earth-surface-gpu';
import { createEarthSurfaceGpuThree, type EarthSurfaceGpuThreeBackendLike } from '../../../render/earth-surface-gpu-three';
import { createEarthSurfaceMaterialBinding } from '../../../render/earth-surface-material-binding';
import {
  bootstrapEarthSurface,
  type EarthSurfaceBootstrapOptions,
  type EarthSurfaceBootstrapResult,
} from './earth-surface-runtime';
import { CloudPresentation } from '../../../render/cloud/cloud-presentation';
import { GeneratedCloudField } from '../../../render/cloud/generated-cloud-field';
import { createDevelopmentClimateMap } from '../../../render/cloud/monthly-climate-fixture';
import { EllipsoidEquirectProjection } from '../../../render/cloud/field-projection';
import { earthSurfaceUvFromRadialNode } from '../../../render/earth-surface-coordinate';
import { LineOverlay, type LatLonPolyline, type UnitSphereLoop } from '../../../render/celestial/line-overlay';
import { GeostationaryOverlay } from '../../../render/celestial/celestial-entity/geostationary-overlay';
import { PointCelestialView } from '../../../render/celestial/celestial-entity/point-celestial-view';
import { SphereCelestialView } from '../../../render/celestial/celestial-entity/sphere-celestial-view';
import { MOON_DIST_TERMS, MOON_LAT_TERMS, MOON_LON_TERMS } from './moon-terms';
import type { AtmosphereOptics } from '../../../render/atmosphere';
import type { CelestialTexture } from '../../../render/celestial-textures';
import { CelestialEntity } from '../celestial-entity/celestial-entity';
import type { EarthSurfaceSource } from './earth-surface-source';
import { vec3 } from 'three/tsl';
import { AU } from '../../../physics/astronomical-unit';

// 地球系に登録された天体の id。表示名も構築の網羅性もこの集合が決める。
export type EarthSystemBodyId = 'earth' | 'moon';

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
  pole: { kind: 'eciPole', spinRate: (2 * Math.PI) / SIDEREAL_DAY },
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

// 地表・雲の殻を合わせたアルベドの測光。倍率は、雲(不透明な積雲の殻・巻雲の殻・積雲の中間調の
// 殻)がアルベド 0.8 で覆う 0.2912 ぶんを A_B=0.306 から引いた残りを、雲に覆われずに残る地表の
// 平均輝度 0.08027 へ割り当てる値。averageHue はその合成の色み。平均はどれもテクスチャ上を
// 緯度余弦で重み付けて測る(不透明な積雲 0.1361・巻雲 0.1056・中間調 0.0494 の順に覆う)。
// TODO: 半透明な殻はアルベドと立つ高さを目で追い込む途中なので、追い込みを終えてから測り直す。
export const EARTH_TEXTURE: CelestialTexture = {
  url: earthTextureUrl,
  albedoScale: 0.9102,
  bondAlbedo: 0.306,
  averageHue: [0.9703, 0.9940, 1.1471],
};

// 地球へ貼る海岸線。tools/export-coastline.mjs が Natural Earth 110m coastline から焼き込んだ、
// 緯度・経度 [deg] のペアを1本の折れ線として並べた配列の配列。形は焼き込み側が保証するので、
// 型を持たない JSON にここで形を与える。
const EARTH_COASTLINE = coastlineData as readonly LatLonPolyline[];

// 月へ貼る主要な海・クレーターの輪郭。tools/export-moon-features.mjs が assets-src/moon-features.json
// の中心緯度経度・直径から円として焼き込んだ、単位球面上の xyz を1ループとして並べた配列の配列。
const MOON_SURFACE_MARKINGS = moonFeaturesData as readonly UnitSphereLoop[];

// 地球のオーロラ。オーバル緯度は磁極の配置、発光高度は降り込む粒子が大気を励起する層、
// 色は酸素の緑(557.7nm)と赤(630nm)の輝線による。
const EARTH_AURORA_OPTICS: AuroraOptics = {
  bodyRadius: 6.371e6,
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

// 実配信物が未設定の開発環境で使う地表の入力。manifest・GPU がそろわないときの代わりになる。
export const EARTH_SURFACE_FIXTURE_SOURCE = {
  datasetId: 'earth-development-fixture',
  sourceManifestSha256: '0'.repeat(64),
  climateEncoding: {
    temperatureK: { min: 180, max: 330 },
    cloudFraction: { min: 0, max: 1 },
    orthometricElevation: { min: -1000, max: 9000 },
    landFraction: { min: 0, max: 1 },
    waterOrthometricElevationM: 0,
  },
  baseUrl: 'https://example.test/earth-surface/',
  manifestUrl: 'https://example.test/earth-surface/earth-surface.json',
  tileIndexUrl: 'https://example.test/earth-surface/tile-index.json',
  baseColorUrl: 'https://example.test/earth-surface/base-color.jpg',
  baseTerrainUrl: 'https://example.test/earth-surface/base-terrain.bin.gz',
  climateMapUrls: Array.from(
    { length: 12 }, (_, month) => `https://example.test/earth-surface/climate-${month + 1}.png`,
  ),
} satisfies EarthSurfaceSource;

// 気候図を貼る回転楕円体の半軸 [m]。
const EARTH_CLIMATE_AXES = vec3(EARTH_ATMOSPHERE.equatorRadius, EARTH_ATMOSPHERE.polarRadius,
  EARTH_ATMOSPHERE.equatorRadius);

export interface EarthSurfaceFactoryOptions extends EarthSurfaceBootstrapOptions {
  readonly renderer?: WebGPURenderer | null;
  readonly colorToRgba8?: EarthSurfaceColorToRgba8;
  readonly decodeImage?: (bytes: Uint8Array, signal?: AbortSignal) => Promise<unknown>;
}

export interface EarthSurfaceFactoryResult {
  readonly surface: EarthSurface;
  readonly state: EarthSurfaceStatus;
  readonly bootstrap: EarthSurfaceBootstrapResult;
}

export interface EarthSurfaceRuntimeHandle {
  readonly surface: EarthSurface;
  readonly ready: Promise<EarthSurfaceFactoryResult>;
}

// 開発用の入力と画像球だけで、status の状態の地表を組む。
function fallbackSurface(status: EarthSurfaceStatus = 'loading'): EarthSurface {
  return new EarthSurface(
    new EarthSurfaceContext(EARTH_SURFACE_FIXTURE_SOURCE),
    CelestialSurface.textured(EARTH_TEXTURE),
    null,
    status,
  );
}

interface EarthSurfaceConnection {
  readonly coordinator: EarthSurfaceResidentCoordinator | null;
  readonly state: EarthSurfaceStatus;
  readonly material: EarthSurfaceMaterialAttachment | null;
  readonly reason: string | null;
}

// 詳細タイル用の材質を、GPU 常駐テクスチャと source の基底画像から組み、地表へ付ける形で返す。
function detailedMaterialFor(
  source: EarthSurfaceSource, textures: EarthSurfaceGpuTextures, fetchImpl?: typeof fetch,
): EarthSurfaceMaterialAttachment {
  const binding = createEarthSurfaceMaterialBinding(
    textures, source.baseColorUrl, source.baseTerrainUrl, fetchImpl,
  );
  // 材質と、その解放・遅延テクスチャ・毎フレーム同期の口を束ねる。
  return {
    material: binding.material,
    deferred: binding.deferredTextures,
    textures: binding.textures,
    onDispose: binding.dispose,
    failureReason: binding.failureReason,
    syncFrame: binding.syncFrame,
  };
}

// bootstrap の結果から、詳細タイルの要求キュー・GPU 常駐を束ねる coordinator と材質を組む。
// 組めなければ coordinator を null にし、fallback/error の状態とその理由を返す。
function coordinatorFor(
  bootstrap: EarthSurfaceBootstrapResult, options: EarthSurfaceFactoryOptions,
): EarthSurfaceConnection {
  // manifest・renderer・タイル源のどれかが欠ければ組めない。
  if (bootstrap.state !== 'ready') {
    return {
      coordinator: null,
      state: bootstrap.state,
      material: null,
      reason: bootstrap.state === 'error'
        ? bootstrap.error?.message ?? 'earth surface bootstrap failed'
        : 'earth surface manifest unavailable',
    };
  }
  if (options.renderer === null || options.renderer === undefined) {
    return { coordinator: null, state: 'fallback', material: null, reason: 'renderer unavailable' };
  }
  if (bootstrap.tileSource === null) {
    return { coordinator: null, state: 'fallback', material: null, reason: 'tile source unavailable' };
  }
  // backend がまだ生成されていない起動経路もあるので、例外で起動を壊さず base へ固定する。
  const backend = options.renderer.backend as unknown as EarthSurfaceGpuThreeBackendLike | null | undefined;
  if (backend === null || backend === undefined) {
    return { coordinator: null, state: 'fallback', material: null, reason: 'WebGPU backend unavailable' };
  }
  // 要求キューと GPU 常駐を確保する。詳細描画に要る機能が無ければ解放して fallback。
  const queue = new EarthSurfaceTileRequestQueue(bootstrap.tileSource, {
    fetchImpl: options.fetchImpl,
    decodeImage: options.decodeImage,
  });
  const gpu = new EarthSurfaceGpuAdapter(createEarthSurfaceGpuThree(
    backend,
  ));
  if (gpu.mode === 'base') {
    queue.dispose();
    gpu.dispose();
    return { coordinator: null, state: 'fallback', material: null, reason: 'WebGPU detail features unavailable' };
  }
  const textures = gpu.textures;
  if (textures === null) {
    queue.dispose();
    gpu.dispose();
    return { coordinator: null, state: 'fallback', material: null, reason: 'detail textures unavailable' };
  }
  // 材質の構築に失敗した場合も、先に確保したqueue/GPUを孤児にしない。
  let material: EarthSurfaceMaterialAttachment;
  try {
    material = detailedMaterialFor(bootstrap.source!, textures, options.fetchImpl);
  } catch (error: unknown) {
    queue.dispose();
    gpu.dispose();
    const message = error instanceof Error ? error.message : String(error);
    return {
      coordinator: null, state: 'fallback', material: null,
      reason: `detail material unavailable: ${message}`,
    };
  }
  return {
    coordinator: new EarthSurfaceResidentCoordinator({
      tiles: new EarthSurfaceTiles(),
      queue,
      gpu,
      colorToRgba8: options.colorToRgba8 ?? defaultEarthSurfaceColorToRgba8,
    }),
    state: 'ready',
    material,
    reason: null,
  };
}

// 画像球だけの地表を即座に返し、manifest・GPU が準備できたら同じ地表へ coordinator と入力を
// 付ける。ready は付け終えた結果で解決し、準備に失敗しても error の状態として解決する。
export function createEarthSurfaceRuntime(
  options: EarthSurfaceFactoryOptions = {},
): EarthSurfaceRuntimeHandle {
  const surface = fallbackSurface();
  const ready = bootstrapEarthSurface({
    ...options,
    fallback: options.fallback ?? EARTH_SURFACE_FIXTURE_SOURCE,
  }).then((bootstrap) => {
    // 準備できた入力で coordinator を組み、地表へ付ける。
    const source = bootstrap.source ?? EARTH_SURFACE_FIXTURE_SOURCE;
    const connection = coordinatorFor(bootstrap, options);
    surface.attach(source, connection.coordinator, connection.state, connection.material, connection.reason);
    return { surface, state: connection.state, bootstrap };
  }).catch((error: unknown) => {
    // 失敗しても、地表は代わりの入力と error の状態で使い続ける。
    const fallback = options.fallback ?? EARTH_SURFACE_FIXTURE_SOURCE;
    const reason = error instanceof Error ? error.message : String(error);
    surface.attach(fallback, null, 'error', null, reason);
    return {
      surface, state: 'error' as const,
      bootstrap: { state: 'error' as const, source: fallback, tileSource: null, error: error instanceof Error ? error : new Error(reason) },
    };
  });
  return { surface, ready };
}

// createEarthSurfaceRuntime の地表が準備を終えるのを待ち、その結果を返す。
export async function createEarthSurface(
  options: EarthSurfaceFactoryOptions = {},
): Promise<EarthSurfaceFactoryResult> {
  return createEarthSurfaceRuntime(options).ready;
}

// タイルの色画像を RGBA8 のバイト列にする。Uint8Array はそのまま返し、ImageBitmap でないか
// canvas が使えない環境では例外を投げる。
async function defaultEarthSurfaceColorToRgba8(color: unknown): Promise<Uint8Array> {
  if (color instanceof Uint8Array) return color;
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
    throw new Error('Earth surface color conversion is unavailable');
  }
  if (!(color instanceof ImageBitmap)) throw new Error('Earth surface color is not an ImageBitmap');
  // 2D canvas へ描いて画素を読み出す。
  const canvas = new OffscreenCanvas(color.width, color.height);
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('Earth surface 2D canvas is unavailable');
  context.drawImage(color, 0, 0);
  return new Uint8Array(context.getImageData(0, 0, color.width, color.height).data);
}

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

// 地球系を組む。宣言順がそのまま重力源配列・一覧の順序になる。
// earthSpinPhase0 は地球の自転初期位相 [rad]。
export function earthSystem(
  sun: StarMotion, phases: PhaseOffsets, simZeroEt: number,
  earthSpinPhase0 = 0, climateEpochUnixSec = 0, renderer?: WebGPURenderer,
): Record<EarthSystemBodyId, CelestialEntity> {
  const earth = planetSystem(planetDefForSimZero(EARTH, phases, simZeroEt), sun, earthSpinPhase0);
  // 気候図。地表の実配信物が準備できたら、その月別気候図へ差し替える。
  const climateUvAt = (direction: Parameters<typeof earthSurfaceUvFromRadialNode>[0]) => (
    earthSurfaceUvFromRadialNode(direction, EARTH_CLIMATE_AXES)
  );
  const climate = createDevelopmentClimateMap(climateUvAt);
  const earthSurfaceRuntime = createEarthSurfaceRuntime({ renderer });
  void earthSurfaceRuntime.ready.then((result) => {
    const source = result.bootstrap.source;
    if (result.bootstrap.state === 'ready' && source !== null) climate.replaceUrls(source.climateMapUrls);
  });
  // 天気を解く半径は全球を一様な球とみなす平均半径、殻を載せる球の半径は本体メッシュと同じ赤道半径。
  const cumulus = new CloudPresentation(
    GeneratedCloudField.global(
      climate, R_EARTH, SIDEREAL_DAY, climateUvAt,
      new EllipsoidEquirectProjection(512, EARTH_CLIMATE_AXES),
    ), R_EARTH_EQ, climateEpochUnixSec,
  );
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
      new SatelliteMotion(satelliteDefForSimZero(MOON, phases, simZeroEt), earth),
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
