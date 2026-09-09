// Shared physical wind representation. Speeds are m/s and vary continuously
// with latitude and altitude; rendering transports may derive their own phase
// from this field without becoming another physical wind source.
export type WindVector = { readonly east: number; readonly north: number };

export const SURFACE_HEIGHT = 1_000;
export const UPPER_CLOUD_HEIGHT = 10_000;
const BAND_LATITUDES = [75, 45, 15, -15, -45, -75] as const;

export class AtmosphericWindField {
  public sample(latitudeRad: number, heightM: number): WindVector {
    const a = Math.abs(latitudeRad);
    const trade = smoothstep(0.18, 0.32, a);
    const westerly = smoothstep(0.28, 0.55, a) * (1 - smoothstep(0.58, 0.72, a));
    const polar = smoothstep(0.62, 1.25, a);
    const layer = smoothstep(SURFACE_HEIGHT, UPPER_CLOUD_HEIGHT, heightM);
    const hemisphere = latitudeRad < 0 ? -1 : 1;
    const eastSurface = -6 * trade + 7 * westerly - 6 * polar;
    const northSurface = -hemisphere * (1.5 * trade - 1.5 * westerly + polar);
    return {
      east: eastSurface + layer * (12 * polar + 13 * westerly - eastSurface),
      north: northSurface + layer * (-northSurface - hemisphere * 0.8),
    };
  }
}

export class CloudPatternTransport {
  public constructor(private readonly field = new AtmosphericWindField()) {}

  // Pattern phase in radians. This is visual transport state, separate from
  // the physical vector returned by AtmosphericWindField.sample().
  public phaseAt(latitudeRad: number, heightM: number, seconds: number): number {
    const wind = this.field.sample(latitudeRad, heightM);
    const speed = Math.hypot(wind.east, wind.north);
    return (seconds * speed) / 6_371_000;
  }

  public angularPhase(degreesPerDay: number, seconds: number): number {
    return (degreesPerDay * Math.PI / 180) * seconds / 86400;
  }
}

export function angularBandsAt(heightM: number): readonly { readonly east: number; readonly north: number }[] {
  const field = new AtmosphericWindField();
  return BAND_LATITUDES.map((degrees) => {
    const latitude = degrees * Math.PI / 180;
    const wind = field.sample(latitude, heightM);
    return {
      east: wind.east * 86400 / (6_371_000 * Math.max(0.25, Math.cos(latitude))) * 180 / Math.PI,
      north: wind.north * 86400 / 6_371_000 * 180 / Math.PI,
    };
  });
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
