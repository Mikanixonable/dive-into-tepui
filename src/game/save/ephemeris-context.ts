import { EPHEMERIS_PACK_VERSION } from '../../physics/ephemeris-pack/format';
import { profileAt } from '../../physics/ephemeris-profile';
import { SIM_EPOCH } from '../sim-epoch';

// Keep this small compatibility module independent from entity save types. In
// particular, the physics test build can exercise it without pulling the DOM
// and Three.js dependent game graph into its Node-only compiler target.
export interface EphemerisContextValue {
  epochJdTdb: number;
  profileId: string;
  packId: string;
  packFormatVersion: number;
}

const currentProfile = profileAt(SIM_EPOCH.value);

// The catalog selects the pack by this profile id. Keeping that catalog key in
// the save makes the context stable without copying any ephemeris coefficients
// into save data. The format version additionally rejects packs that cannot be
// interpreted by the current evaluator.
export const CURRENT_EPHEMERIS_CONTEXT: Readonly<EphemerisContextValue> = Object.freeze({
  epochJdTdb: SIM_EPOCH.value,
  profileId: currentProfile.id,
  packId: currentProfile.packId,
  packFormatVersion: EPHEMERIS_PACK_VERSION,
});

export type EphemerisContextStatus = 'legacy' | 'compatible' | 'incompatible';

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isValidContext(value: unknown): value is EphemerisContextValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  return isFiniteNumber(context.epochJdTdb) &&
    isNonEmptyString(context.profileId) &&
    isNonEmptyString(context.packId) &&
    typeof context.packFormatVersion === 'number' &&
    Number.isSafeInteger(context.packFormatVersion) &&
    context.packFormatVersion > 0;
}

export function ephemerisContextStatus(
  saved: unknown,
  current: Readonly<EphemerisContextValue> = CURRENT_EPHEMERIS_CONTEXT,
): EphemerisContextStatus {
  // Absence is the explicitly supported legacy migration path. null and any
  // malformed value are explicit-but-invalid context and must not be treated
  // as legacy data.
  if (saved === undefined) return 'legacy';
  if (!isValidContext(saved)) return 'incompatible';

  return saved.epochJdTdb === current.epochJdTdb &&
    saved.profileId === current.profileId &&
    saved.packId === current.packId &&
    saved.packFormatVersion === current.packFormatVersion
    ? 'compatible'
    : 'incompatible';
}

export function isEphemerisContextCompatible(
  saved: unknown,
  current: Readonly<EphemerisContextValue> = CURRENT_EPHEMERIS_CONTEXT,
): boolean {
  return ephemerisContextStatus(saved, current) !== 'incompatible';
}
