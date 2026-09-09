// Deterministic auroral field. This module contains the geomagnetic coordinate
// and emission model; Aurora owns only the Three.js buffers that consume it.
export type AuroraFieldOptions = {
  readonly ovalLatitudeDeg: number;
  readonly geomSeed: number;
  readonly colorSeed: number;
  readonly phaseOffset: number;
  readonly sign: 1 | -1;
};

export type AuroraFrame = {
  readonly magneticPoleLatitudeDeg: number;
  readonly magneticLocalTime: number;
  readonly latitudeDeg: number;
  readonly altitudeScale: number;
  readonly intensity: number;
  readonly greenEmission: number;
  readonly redEmission: number;
};

export class AuroraField {
  public constructor(private readonly options: AuroraFieldOptions) {}

  public frameAt(theta: number, phase: number): AuroraFrame {
    const { ovalLatitudeDeg: oval, geomSeed, colorSeed, phaseOffset, sign } = this.options;
    const magneticLatitude = oval + 4.5 * Math.sin(3 * theta + geomSeed + phase)
      + 2.2 * Math.sin(7 * theta + (geomSeed + phase) * 2.3);
    const activity = clamp01(0.4 + 0.6 * Math.sin(5 * theta + (colorSeed + phase) * 0.8)
      + 0.4 * Math.sin(11 * theta - (colorSeed + phase) * 1.3));
    const daySide = 0.72 + 0.28 * Math.max(0, Math.cos(theta));
    const activityProxy = 0.62 + 0.28 * Math.sin(phase * 0.11 + phaseOffset * 1.7);
    const pulse = 0.55 + 0.2 * Math.sin(phase * 0.7 + phaseOffset * 2.1)
      * Math.sin(phase * 0.23 + phaseOffset);
    const altitudeScale = 0.7 + 0.3 * Math.sin(2 * theta + (geomSeed + phase) * 1.7);
    return {
      magneticPoleLatitudeDeg: oval,
      magneticLocalTime: ((theta / (2 * Math.PI) + phase / (2 * Math.PI)) % 1 + 1) % 1 * 24,
      latitudeDeg: magneticLatitude * sign,
      altitudeScale,
      intensity: activity * daySide * activityProxy * pulse,
      greenEmission: clamp01(0.72 + 0.2 * Math.sin(19 * theta + (colorSeed + phase) * 4.1)),
      redEmission: clamp01(0.22 + 0.42 * altitudeScale + 0.12 * Math.sin(3 * theta + phase * 0.17)),
    };
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
