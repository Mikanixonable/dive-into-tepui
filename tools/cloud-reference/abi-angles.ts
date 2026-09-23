// GOES-R ABI 画素ごとの太陽・衛星観測角を求める。
// 太陽位置は簡略な天文近似を使う。NOAA GML の式との標本比較では、
// 太陽方向の差は 0.6° 未満、天頂角の差は 0.5° 未満。全条件の誤差保証や
// NREL SPA と同等の精度を意味しない。地形・屈折・雲視差の補正も行わない。
// 固定格子と測地座標の対応: NOAA GOES-R ABI PUG 第3巻
// https://www.ospo.noaa.gov/resources/documents/PUG/GS%20Series%20416-R-PUG-L1B-0347%20Vol%203%20Rev%202.3.pdf
// 太陽方位角の基準: NOAA GML の一般式(北から時計回り)
// https://gml.noaa.gov/grad/solcalc/solareqns.PDF
// 高精度な照合手法: NREL/TP-560-34302 (Reda・Andreas, 2008)
// https://www.nrel.gov/docs/fy08osti/34302.pdf

import {
  abiFixedGridToGeodetic,
  type AbiFixedGridCoordinate,
  type AbiFixedGridProjection,
} from './abi-projection';

export interface AbiPixelAngles {
  /** 局所測地鉛直から測った太陽天頂角 [rad]。 */
  readonly solarZenithRadians: number;
  /** 局所北から時計回りに測った太陽方位角 [rad]、範囲 [0, 2π)。 */
  readonly solarAzimuthRadians: number;
  /** 局所測地鉛直から測った衛星観測天頂角 [rad]。 */
  readonly satelliteZenithRadians: number;
}

/**
 * GOES 固定格子座標と UTC 撮像時刻から画素ごとの角度を求める。
 * 地表高度は投影楕円体上のゼロとする。屈折・地形・視差・衛星位置変動・
 * ラインごとの走査時刻は扱わない。ABI 光線が楕円体と交差しなければ null。
 */
export function abiPixelAngles(
  coordinate: AbiFixedGridCoordinate,
  projection: AbiFixedGridProjection,
  scanTimeUtc: string,
): AbiPixelAngles | null {
  const point = abiFixedGridToGeodetic(coordinate, projection);
  if (point === null) return null;
  const timestamp = parseUtcTimestamp(scanTimeUtc);
  const solar = solarDirection(timestamp, point.latitudeRadians, point.longitudeRadians);
  const viewing = satelliteZenith(point.latitudeRadians, point.longitudeRadians, projection);
  return {
    solarZenithRadians: Math.acos(clamp(solar.up, -1, 1)),
    solarAzimuthRadians: normalizeAngle(Math.atan2(solar.east, solar.north)),
    satelliteZenithRadians: Math.acos(clamp(viewing, -1, 1)),
  };
}

/** UTC を明示した ISO 8601 時刻だけを受け付ける。 */
function parseUtcTimestamp(value: string): number {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)) {
    throw new Error('ABI scan time must be an ISO UTC timestamp ending in Z');
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new Error('ABI scan time must be a valid UTC timestamp');
  }
  return milliseconds;
}

/** NOAA 形式の見かけの地心太陽方向を局所 ENU 座標へ写す。 */
function solarDirection(timestampMilliseconds: number, latitude: number, longitude: number): { east: number; north: number; up: number } {
  const julianDay = timestampMilliseconds / 86_400_000 + 2_440_587.5;
  const centuries = (julianDay - 2_451_545) / 36_525;
  const meanLongitude = normalizeDegrees(280.46646 + centuries * (36_000.76983 + centuries * 0.0003032));
  const meanAnomaly = degreesToRadians(normalizeDegrees(357.52911 + centuries * (35_999.05029 - 0.0001537 * centuries)));
  const equationOfCenterDegrees =
    (1.914602 - centuries * (0.004817 + 0.000014 * centuries)) * Math.sin(meanAnomaly)
      + (0.019993 - 0.000101 * centuries) * Math.sin(2 * meanAnomaly)
      + 0.000289 * Math.sin(3 * meanAnomaly);
  const apparentLongitude = degreesToRadians(meanLongitude + equationOfCenterDegrees - 0.00569 - 0.00478 * Math.sin(degreesToRadians(125.04 - 1934.136 * centuries)));
  const obliquity = degreesToRadians(23.439291 - 0.0130042 * centuries + 0.00256 * Math.cos(degreesToRadians(125.04 - 1934.136 * centuries)));
  const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(apparentLongitude), Math.cos(apparentLongitude));
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(apparentLongitude));
  const siderealDegrees = normalizeDegrees(280.46061837 + 360.98564736629 * (julianDay - 2_451_545)
    + 0.000387933 * centuries ** 2 - centuries ** 3 / 38_710_000);
  const hourAngle = wrapRadians(degreesToRadians(siderealDegrees) + longitude - rightAscension);
  const east = -Math.cos(declination) * Math.sin(hourAngle);
  const north = Math.cos(latitude) * Math.sin(declination) - Math.sin(latitude) * Math.cos(declination) * Math.cos(hourAngle);
  const up = Math.sin(latitude) * Math.sin(declination) + Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle);
  return { east, north, up };
}

/** 測地面法線と正規化した地表から衛星への視線の内積。 */
function satelliteZenith(latitude: number, longitude: number, projection: AbiFixedGridProjection): number {
  const { semiMajorAxisMeters: a, semiMinorAxisMeters: b } = projection;
  const eccentricitySquared = 1 - (b * b) / (a * a);
  const sinLatitude = Math.sin(latitude);
  const normalRadius = a / Math.sqrt(1 - eccentricitySquared * sinLatitude ** 2);
  const pointX = normalRadius * Math.cos(latitude) * Math.cos(longitude);
  const pointY = normalRadius * Math.cos(latitude) * Math.sin(longitude);
  const pointZ = normalRadius * (1 - eccentricitySquared) * sinLatitude;
  const satelliteRadius = a + projection.perspectivePointHeightMeters;
  const satelliteLongitude = projection.longitudeOfProjectionOriginRadians;
  const rayX = satelliteRadius * Math.cos(satelliteLongitude) - pointX;
  const rayY = satelliteRadius * Math.sin(satelliteLongitude) - pointY;
  const rayZ = -pointZ;
  const rayLength = Math.hypot(rayX, rayY, rayZ);
  const upX = Math.cos(latitude) * Math.cos(longitude);
  const upY = Math.cos(latitude) * Math.sin(longitude);
  const upZ = Math.sin(latitude);
  return (rayX * upX + rayY * upY + rayZ * upZ) / rayLength;
}

function normalizeDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

function normalizeAngle(value: number): number {
  return ((value % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
}

function wrapRadians(value: number): number {
  return ((value + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
}

function degreesToRadians(value: number): number {
  return value * Math.PI / 180;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
