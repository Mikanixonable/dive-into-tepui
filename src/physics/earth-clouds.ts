// 地球雲の決定論的な移流・球面投影・雲影投影。
//
// ここには THREE/WebGPU を持ち込まない。表示側はこのファイルの位相と投影則を
// シェーダへ移すため、同じ simTime を渡せば time warp の経路やフレームレートに
// 依存せず、常に同じ雲画像になる。
import { Vec3, dot, len, norm, scale, sub, v3 } from './vec3';

export type CloudLayer = 'low' | 'high';

export interface CloudLayerParameters {
  /** 地表に対する相対東向き速度 [m/s]。正は経度が増える向き。 */
  readonly eastwardSpeed: number;
  /** 緯度方向の緩い変形速度 [rad/s]。 */
  readonly deformationRate: number;
  /** 変形の経度振幅 [rad]。 */
  readonly deformationAmplitude: number;
  /** 高層雲の模様スケール。 */
  readonly longitudinalScale: number;
  readonly latitudinalScale: number;
}

export const EARTH_CLOUD_RADIUS = 6_371_000;
export const LOW_CLOUD_ALTITUDE = 2_000;
export const HIGH_CLOUD_ALTITUDE = 10_000;

// 実在の全球平均風を再現する気象モデルではなく、衛星から見て不自然に同期しない
// 最小の二層モデル。速度差は地表固定の雲塊が同じ速度で流れる印象を避ける。
export const CLOUD_LAYER_PARAMETERS: Readonly<Record<CloudLayer, CloudLayerParameters>> = {
  low: {
    eastwardSpeed: 11,
    deformationRate: 1.7e-6,
    deformationAmplitude: 0.008,
    longitudinalScale: 1,
    latitudinalScale: 1,
  },
  high: {
    eastwardSpeed: 24,
    deformationRate: 1.1e-6,
    deformationAmplitude: 0.014,
    longitudinalScale: 1.035,
    latitudinalScale: 1.045,
  },
};

export interface CloudPhase {
  /** UVの経度方向オフセット [0, 1)。 */
  readonly longitudeOffset: number;
  /** 緯度方向へ加えるシーム安全な変形の位相 [rad]。 */
  readonly deformationPhase: number;
  readonly deformationAmplitude: number;
  readonly longitudinalScale: number;
  readonly latitudinalScale: number;
}

const TWO_PI = Math.PI * 2;

function finiteTime(timeSeconds: number): number {
  return Number.isFinite(timeSeconds) ? timeSeconds : 0;
}

function wrapUnit(value: number): number {
  const result = value - Math.floor(value);
  return result < 0 ? result + 1 : result;
}

/** 指定時刻の層位相。累積状態を持たないので同じ時刻は常に同じ結果になる。 */
export function cloudPhaseAt(timeSeconds: number, layer: CloudLayer): CloudPhase {
  const t = finiteTime(timeSeconds);
  const p = CLOUD_LAYER_PARAMETERS[layer];
  return {
    longitudeOffset: wrapUnit((p.eastwardSpeed * t) / (EARTH_CLOUD_RADIUS * TWO_PI)),
    deformationPhase: t * p.deformationRate,
    deformationAmplitude: p.deformationAmplitude,
    longitudinalScale: p.longitudinalScale,
    latitudinalScale: p.latitudinalScale,
  };
}

export interface CloudUv {
  readonly u: number;
  readonly v: number;
}

/** 単位球方向をSphereGeometryと同じ向きのequirectangular UVへ変換する。 */
export function directionToCloudUv(direction: Vec3): CloudUv {
  const d = norm(direction);
  return {
    u: wrapUnit(Math.atan2(d.z, d.x) / TWO_PI + 0.5),
    v: Math.acos(Math.max(-1, Math.min(1, d.y))) / Math.PI,
  };
}

/** 球面上の基準UVへ、層の移流と低周波変形を適用する。経度は常にwrapする。 */
export function advectCloudUv(base: CloudUv, timeSeconds: number, layer: CloudLayer): CloudUv {
  const p = cloudPhaseAt(timeSeconds, layer);
  const deformation = Math.sin((base.v - 0.5) * Math.PI * 2 * 2.2 + p.deformationPhase)
    * p.deformationAmplitude;
  const latitude = Math.max(-1, Math.min(1, base.v * 2 - 1));
  const longitude = (base.u - 0.5) * p.longitudinalScale + 0.5 + p.longitudeOffset;
  const v = Math.max(0, Math.min(1, 0.5 + latitude * p.latitudinalScale * 0.5 + deformation));
  return { u: wrapUnit(longitude), v };
}

/** 地表点から太陽方向へ伸ばした光線と雲層球の交点。 */
export function projectToCloudLayer(
  surfaceDirection: Vec3,
  sunDirection: Vec3,
  cloudAltitude: number,
  earthRadius = EARTH_CLOUD_RADIUS,
): Vec3 {
  const n = norm(surfaceDirection);
  const sun = norm(sunDirection);
  const origin = scale(n, earthRadius);
  const b = dot(origin, sun);
  const radius = earthRadius + Math.max(0, cloudAltitude);
  const discriminant = b * b + radius * radius - earthRadius * earthRadius;
  const distance = -b + Math.sqrt(Math.max(0, discriminant));
  return norm(addVec(origin, scale(sun, distance)));
}

/** 雲の投影位置が数値的に球面上にあることを保つ小さな純関数。 */
function addVec(a: Vec3, b: Vec3): Vec3 {
  return v3(a.x + b.x, a.y + b.y, a.z + b.z);
}

/** 雲影に使う層別の投影方向。高層雲の影はわずかに広がる。 */
export function cloudShadowDirection(
  surfaceDirection: Vec3,
  sunDirection: Vec3,
  layer: CloudLayer,
  earthRadius = EARTH_CLOUD_RADIUS,
): Vec3 {
  const altitude = layer === 'low' ? LOW_CLOUD_ALTITUDE : HIGH_CLOUD_ALTITUDE;
  return projectToCloudLayer(surfaceDirection, sunDirection, altitude, earthRadius);
}

/** 雲影投影の接線方向距離 [m]。診断と純関数テスト用。 */
export function cloudShadowOffset(
  surfaceDirection: Vec3,
  sunDirection: Vec3,
  cloudAltitude: number,
  earthRadius = EARTH_CLOUD_RADIUS,
): number {
  const n = norm(surfaceDirection);
  const projected = projectToCloudLayer(n, sunDirection, cloudAltitude, earthRadius);
  return len(sub(scale(projected, earthRadius), scale(n, earthRadius)));
}
