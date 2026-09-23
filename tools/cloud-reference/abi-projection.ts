// GOES-R ABI 固定格子座標と GRS80 測地座標を相互変換する。

export interface AbiFixedGridProjection {
  readonly perspectivePointHeightMeters: number;
  readonly semiMajorAxisMeters: number;
  readonly semiMinorAxisMeters: number;
  readonly longitudeOfProjectionOriginRadians: number;
}

export interface AbiFixedGridCoordinate {
  readonly xAngleRadians: number;
  readonly yAngleRadians: number;
}

export interface AbiGeodeticCoordinate {
  readonly latitudeRadians: number;
  readonly longitudeRadians: number;
}

/** x または y の packed 座標値を画素中心の角度 [rad] へ復号する。 */
export function decodeAbiFixedGridCoordinate(
  packedValue: number,
  scaleFactor: number,
  addOffset: number,
): number {
  if (![packedValue, scaleFactor, addOffset].every(Number.isFinite)) {
    throw new Error('ABI fixed-grid coordinate values must be finite');
  }
  return packedValue * scaleFactor + addOffset;
}

/** sweep=x の走査角を GRS80 楕円体との最初の交点へ変換する。 */
export function abiFixedGridToGeodetic(
  coordinate: AbiFixedGridCoordinate,
  projection: AbiFixedGridProjection,
): AbiGeodeticCoordinate | null {
  validateProjection(projection);
  if (![coordinate.xAngleRadians, coordinate.yAngleRadians].every(Number.isFinite)) {
    throw new Error('ABI fixed-grid angles must be finite');
  }

  const { xAngleRadians: x, yAngleRadians: y } = coordinate;
  const { semiMajorAxisMeters: a, semiMinorAxisMeters: b, longitudeOfProjectionOriginRadians: longitudeOrigin } = projection;
  const satelliteDistance = projection.perspectivePointHeightMeters + a;
  const ratioSquared = (a * a) / (b * b);
  const quadraticA = Math.sin(x) ** 2 + Math.cos(x) ** 2 * (Math.cos(y) ** 2 + ratioSquared * Math.sin(y) ** 2);
  const quadraticB = -2 * satelliteDistance * Math.cos(x) * Math.cos(y);
  const quadraticC = satelliteDistance ** 2 - a ** 2;
  const discriminant = quadraticB ** 2 - 4 * quadraticA * quadraticC;
  if (discriminant < 0) return null;

  const distance = (-quadraticB - Math.sqrt(discriminant)) / (2 * quadraticA);
  const satelliteX = distance * Math.cos(x) * Math.cos(y);
  const satelliteY = -distance * Math.sin(x);
  const satelliteZ = distance * Math.cos(x) * Math.sin(y);
  const towardEarth = satelliteDistance - satelliteX;
  const latitude = Math.atan2(ratioSquared * satelliteZ, Math.hypot(towardEarth, satelliteY));
  const longitude = longitudeOrigin - Math.atan2(satelliteY, towardEarth);

  return { latitudeRadians: latitude, longitudeRadians: longitude };
}

/** 可視な GRS80 測地座標を GOES-R sweep=x 走査角へ変換する。 */
export function geodeticToAbiFixedGrid(
  coordinate: AbiGeodeticCoordinate,
  projection: AbiFixedGridProjection,
): AbiFixedGridCoordinate | null {
  validateProjection(projection);
  if (![coordinate.latitudeRadians, coordinate.longitudeRadians].every(Number.isFinite)) {
    throw new Error('Geodetic coordinates must be finite');
  }
  if (Math.abs(coordinate.latitudeRadians) > Math.PI / 2) {
    throw new Error('Geodetic latitude must be between -π/2 and π/2');
  }

  const { semiMajorAxisMeters: a, semiMinorAxisMeters: b, longitudeOfProjectionOriginRadians: longitudeOrigin } = projection;
  const eccentricitySquared = 1 - (b * b) / (a * a);
  const sinLatitude = Math.sin(coordinate.latitudeRadians);
  const primeVerticalRadius = a / Math.sqrt(1 - eccentricitySquared * sinLatitude ** 2);
  const earthX = primeVerticalRadius * Math.cos(coordinate.latitudeRadians) * Math.cos(coordinate.longitudeRadians);
  const earthY = primeVerticalRadius * Math.cos(coordinate.latitudeRadians) * Math.sin(coordinate.longitudeRadians);
  const earthZ = primeVerticalRadius * (1 - eccentricitySquared) * sinLatitude;
  const cosOrigin = Math.cos(longitudeOrigin);
  const sinOrigin = Math.sin(longitudeOrigin);
  const towardEarthX = projection.perspectivePointHeightMeters + a - (earthX * cosOrigin + earthY * sinOrigin);
  const eastwardY = -earthX * sinOrigin + earthY * cosOrigin;
  const northwardZ = earthZ;

  const surfaceNormalEast = (earthY * cosOrigin - earthX * sinOrigin) / (a * a);
  const surfaceNormalTowardSatellite = (earthX * cosOrigin + earthY * sinOrigin) / (a * a);
  const surfaceNormalNorth = earthZ / (b * b);
  const satelliteDirectionDotNormal =
    surfaceNormalTowardSatellite * towardEarthX
    - surfaceNormalEast * eastwardY
    - surfaceNormalNorth * northwardZ;
  if (satelliteDirectionDotNormal <= 0) return null;

  const xAngleRadians = Math.atan2(eastwardY, Math.hypot(towardEarthX, northwardZ));
  const yAngleRadians = Math.atan2(northwardZ, towardEarthX);
  return { xAngleRadians, yAngleRadians };
}

function validateProjection(projection: AbiFixedGridProjection): void {
  if (
    ![
      projection.perspectivePointHeightMeters,
      projection.semiMajorAxisMeters,
      projection.semiMinorAxisMeters,
      projection.longitudeOfProjectionOriginRadians,
    ].every(Number.isFinite)
    || projection.perspectivePointHeightMeters <= 0
    || projection.semiMajorAxisMeters <= 0
    || projection.semiMinorAxisMeters <= 0
    || projection.semiMinorAxisMeters > projection.semiMajorAxisMeters
  ) {
    throw new Error('ABI fixed-grid projection parameters are invalid');
  }
}
