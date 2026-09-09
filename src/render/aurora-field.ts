// Deterministic auroral field. This module contains the geomagnetic coordinate
// and emission model; Aurora owns only the Three.js buffers that consume it.
export type AuroraFieldOptions = {
  readonly ovalLatitudeDeg: number;
  readonly magneticPoleLatitudeDeg?: number;
  readonly magneticPoleLongitudeDeg?: number;
  readonly geomSeed: number;
  readonly colorSeed: number;
  readonly phaseOffset: number;
  readonly sign: 1 | -1;
};

export type AuroraFrame = {
  readonly magneticPoleLatitudeDeg: number;
  readonly magneticLocalTime: number;
  readonly latitudeDeg: number;
  readonly longitudeDeg: number;
  readonly altitudeScale: number;
  readonly intensity: number;
  readonly greenEmission: number;
  readonly redEmission: number;
};

export class AuroraField {
  public constructor(private readonly options: AuroraFieldOptions) {}

  public frameAt(theta: number, phase: number, solarMeridianRad = 0, latitudeOffsetDeg = 0): AuroraFrame {
    const {
      ovalLatitudeDeg: oval,
      magneticPoleLatitudeDeg = 90,
      magneticPoleLongitudeDeg = 0,
      geomSeed,
      colorSeed,
      phaseOffset,
      sign,
    } = this.options;
    const magneticLatitude = oval + latitudeOffsetDeg
      + 4.5 * Math.sin(3 * theta + geomSeed + phase)
      + 2.2 * Math.sin(7 * theta + (geomSeed + phase) * 2.3);
    const activity = clamp01(0.4 + 0.6 * Math.sin(5 * theta + (colorSeed + phase) * 0.8)
      + 0.4 * Math.sin(11 * theta - (colorSeed + phase) * 1.3));
    const localTimeAngle = wrapAngle(theta - solarMeridianRad);
    const daySide = 0.72 + 0.28 * Math.max(0, Math.cos(localTimeAngle));
    const activityProxy = 0.62 + 0.28 * Math.sin(phase * 0.11 + phaseOffset * 1.7);
    const pulse = 0.55 + 0.2 * Math.sin(phase * 0.7 + phaseOffset * 2.1)
      * Math.sin(phase * 0.23 + phaseOffset);
    const altitudeScale = 0.7 + 0.3 * Math.sin(2 * theta + (geomSeed + phase) * 1.7);
    const poleLatitude = (magneticPoleLatitudeDeg * sign * Math.PI) / 180;
    const poleLongitude = ((magneticPoleLongitudeDeg + (sign < 0 ? 180 : 0)) * Math.PI) / 180;
    const magneticLat = (magneticLatitude * Math.PI) / 180;
    const pole = sphericalVector(poleLatitude, poleLongitude);
    const poleNorth = sphericalVector(Math.PI / 2 - poleLatitude, poleLongitude + Math.PI);
    const poleEast = { x: -Math.sin(poleLongitude), y: 0, z: Math.cos(poleLongitude) };
    const localCos = Math.cos(magneticLat);
    const localSin = Math.sin(magneticLat);
    const x = pole.x * localSin + (poleNorth.x * Math.cos(theta) + poleEast.x * Math.sin(theta)) * localCos;
    const y = pole.y * localSin + (poleNorth.y * Math.cos(theta) + poleEast.y * Math.sin(theta)) * localCos;
    const z = pole.z * localSin + (poleNorth.z * Math.cos(theta) + poleEast.z * Math.sin(theta)) * localCos;
    return {
      magneticPoleLatitudeDeg: magneticPoleLatitudeDeg * sign,
      magneticLocalTime: (localTimeAngle / (2 * Math.PI)) * 24,
      latitudeDeg: (Math.asin(Math.max(-1, Math.min(1, y))) * 180) / Math.PI,
      longitudeDeg: (Math.atan2(z, x) * 180) / Math.PI,
      altitudeScale,
      intensity: activity * daySide * activityProxy * pulse,
      greenEmission: clamp01(0.72 + 0.2 * Math.sin(19 * theta + (colorSeed + phase) * 4.1)),
      redEmission: clamp01(0.22 + 0.42 * altitudeScale + 0.12 * Math.sin(3 * theta + phase * 0.17)),
    };
  }
}

function sphericalVector(latitude: number, longitude: number): { x: number; y: number; z: number } {
  const cosLatitude = Math.cos(latitude);
  return {
    x: cosLatitude * Math.cos(longitude),
    y: Math.sin(latitude),
    z: cosLatitude * Math.sin(longitude),
  };
}

function wrapAngle(angle: number): number {
  const wrapped = angle % (2 * Math.PI);
  return wrapped < 0 ? wrapped + 2 * Math.PI : wrapped;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
