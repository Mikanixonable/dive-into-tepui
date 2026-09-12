// Deterministic auroral field. This module contains the geomagnetic coordinate
// and emission model; Aurora owns only the Three.js buffers that consume it.
import { dot, v3, type Vec3 } from '../math/vec3';

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

// 磁極を中心とした方位の基準系。theta = 0 が north の向き、theta = π/2 が east の向き。
type PoleFrame = { readonly pole: Vec3; readonly north: Vec3; readonly east: Vec3 };

export class AuroraField {
  public constructor(private readonly options: AuroraFieldOptions) {}

  // 天体固定の単位方向が指す磁気方位 [rad]。frameAt の solarMeridianRad は theta と同じ基準で
  // 測るので、太陽の向きはこの関数でその基準へ落としてから渡す。**地理経度をそのまま渡さない**
  // — 磁極は自転軸から傾いているので、その傾きぶん昼夜の境が回ってずれる。
  public solarMeridianFor(direction: Vec3): number {
    const { north, east } = this.poleFrame();
    return Math.atan2(dot(direction, east), dot(direction, north));
  }

  public frameAt(theta: number, phase: number, solarMeridianRad = 0, latitudeOffsetDeg = 0): AuroraFrame {
    const {
      ovalLatitudeDeg: oval,
      magneticPoleLatitudeDeg = 90,
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
    const magneticLat = (magneticLatitude * Math.PI) / 180;
    const { pole, north: poleNorth, east: poleEast } = this.poleFrame();
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

  // この極のオーバルが載る基準系。南極側(sign < 0)は極の緯度を反転し、経度を半周ずらす。
  private poleFrame(): PoleFrame {
    const { magneticPoleLatitudeDeg = 90, magneticPoleLongitudeDeg = 0, sign } = this.options;
    const poleLatitude = (magneticPoleLatitudeDeg * sign * Math.PI) / 180;
    const poleLongitude = ((magneticPoleLongitudeDeg + (sign < 0 ? 180 : 0)) * Math.PI) / 180;
    return {
      pole: sphericalVector(poleLatitude, poleLongitude),
      north: sphericalVector(Math.PI / 2 - poleLatitude, poleLongitude + Math.PI),
      east: v3(-Math.sin(poleLongitude), 0, Math.cos(poleLongitude)),
    };
  }
}

function sphericalVector(latitude: number, longitude: number): Vec3 {
  const cosLatitude = Math.cos(latitude);
  return v3(cosLatitude * Math.cos(longitude), Math.sin(latitude), cosLatitude * Math.sin(longitude));
}

function wrapAngle(angle: number): number {
  const wrapped = angle % (2 * Math.PI);
  return wrapped < 0 ? wrapped + 2 * Math.PI : wrapped;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
