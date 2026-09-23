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
  const distance = groundRayDistance(x, y, satelliteDistance, a, ratioSquared);
  if (distance === null) return null;
  const satelliteX = distance * Math.cos(x) * Math.cos(y);
  const satelliteY = -distance * Math.sin(x);
  const satelliteZ = distance * Math.cos(x) * Math.sin(y);
  const towardEarth = satelliteDistance - satelliteX;
  const latitude = Math.atan2(ratioSquared * satelliteZ, Math.hypot(towardEarth, satelliteY));
  const longitude = longitudeOrigin - Math.atan2(satelliteY, towardEarth);

  return { latitudeRadians: latitude, longitudeRadians: longitude };
}

/** 地表にも交差する視線を、指定した楕円体上の幾何高度 [m] の雲頂まで戻す。 */
export function abiFixedGridToCloudTopGeodetic(
  coordinate: AbiFixedGridCoordinate,
  projection: AbiFixedGridProjection,
  geometricHeightMeters: number,
): AbiGeodeticCoordinate | null {
  validateProjection(projection);
  if (!Number.isFinite(geometricHeightMeters) || geometricHeightMeters < 0
    || geometricHeightMeters >= projection.perspectivePointHeightMeters) {
    throw new Error('ABI cloud-top geometric height must be between zero and satellite altitude');
  }
  if (![coordinate.xAngleRadians, coordinate.yAngleRadians].every(Number.isFinite)) {
    throw new Error('ABI fixed-grid angles must be finite');
  }
  if (geometricHeightMeters === 0) return abiFixedGridToGeodetic(coordinate, projection);

  const { xAngleRadians: x, yAngleRadians: y } = coordinate;
  const { semiMajorAxisMeters: a, semiMinorAxisMeters: b } = projection;
  const satelliteDistance = projection.perspectivePointHeightMeters + a;
  const directionX = -Math.cos(x) * Math.cos(y);
  const directionY = Math.sin(x);
  const directionZ = Math.cos(x) * Math.sin(y);
  const ratioSquared = (a * a) / (b * b);
  const groundDistance = groundRayDistance(x, y, satelliteDistance, a, ratioSquared);
  if (groundDistance === null) return null;

  let near = 0;
  let far = groundDistance;
  for (let iteration = 0; iteration < 42; iteration += 1) {
    const middle = (near + far) / 2;
    const earthX = satelliteDistance + middle * directionX;
    const earthY = middle * directionY;
    const earthZ = middle * directionZ;
    if (geodeticAltitudeMeters(earthX, earthY, earthZ, a, b) > geometricHeightMeters) near = middle;
    else far = middle;
  }
  const distance = (near + far) / 2;
  const earthX = satelliteDistance + distance * directionX;
  const earthY = distance * directionY;
  const earthZ = distance * directionZ;
  const latitude = geodeticLatitudeRadians(earthX, earthY, earthZ, a, b);
  const longitude = projection.longitudeOfProjectionOriginRadians + Math.atan2(earthY, earthX);
  return { latitudeRadians: latitude, longitudeRadians: longitude };
}

/** 楕円体との最初の交点までの衛星視線距離を返す。 */
function groundRayDistance(x: number, y: number, satelliteDistance: number, a: number, ratioSquared: number): number | null {
  const quadraticA = Math.sin(x) ** 2 + Math.cos(x) ** 2 * (Math.cos(y) ** 2 + ratioSquared * Math.sin(y) ** 2);
  const quadraticB = -2 * satelliteDistance * Math.cos(x) * Math.cos(y);
  const quadraticC = satelliteDistance ** 2 - a ** 2;
  const discriminant = quadraticB ** 2 - 4 * quadraticA * quadraticC;
  return discriminant < 0 ? null : (-quadraticB - Math.sqrt(discriminant)) / (2 * quadraticA);
}

/** Bowring の補助角から、楕円体上の測地緯度を求める。 */
function geodeticLatitudeRadians(x: number, y: number, z: number, a: number, b: number): number {
  const eccentricitySquared = 1 - (b * b) / (a * a);
  const secondEccentricitySquared = (a * a) / (b * b) - 1;
  const polarDistance = Math.hypot(x, y);
  const auxiliary = Math.atan2(z * a, polarDistance * b);
  return Math.atan2(
    z + secondEccentricitySquared * b * Math.sin(auxiliary) ** 3,
    polarDistance - eccentricitySquared * a * Math.cos(auxiliary) ** 3,
  );
}

/** 視線上の点の楕円体上幾何高度を求める。 */
function geodeticAltitudeMeters(x: number, y: number, z: number, a: number, b: number): number {
  const latitude = geodeticLatitudeRadians(x, y, z, a, b);
  const eccentricitySquared = 1 - (b * b) / (a * a);
  const normalRadius = a / Math.sqrt(1 - eccentricitySquared * Math.sin(latitude) ** 2);
  const polarDistance = Math.hypot(x, y);
  return Math.abs(Math.cos(latitude)) > 0.25
    ? polarDistance / Math.cos(latitude) - normalRadius
    : z / Math.sin(latitude) - normalRadius * (1 - eccentricitySquared);
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
