import { EPHEMERIS_PACK_VERSION } from '../../physics/ephemeris/pack-format';
import { profileAtOrNull } from '../../physics/ephemeris/profile';
import { createJulianDate, TdbJulianDate } from '../../physics/time';

// Keep this small compatibility module independent from entity save types. In
// particular, the physics test build can exercise it without pulling the DOM
// and Three.js dependent game graph into its Node-only compiler target.
interface EphemerisContextValue {
  // このランの元期(simTime=0 が指す絶対時刻)。**照合の対象ではなく、継承する値。**
  epochJdTdb: number;
  // その元期が選ぶ暦プロファイルと暦パック。数値暦を持たない時代では両方 null。
  profileId: string | null;
  packId: string | null;
  packFormatVersion: number;
}

// The catalog selects the pack by this profile id. Keeping that catalog key in
// the save makes the context stable without copying any ephemeris coefficients
// into save data. The format version additionally rejects packs that cannot be
// interpreted by the current evaluator.
//
// This takes the run's epoch rather than reading a shared constant: the epoch is
// a per-run value, and this module must stay free of the game graph so the
// physics test build can exercise it.
export function ephemerisContextFor(epoch: TdbJulianDate): Readonly<EphemerisContextValue> {
  const profile = profileAtOrNull(epoch.value);
  return Object.freeze({
    epochJdTdb: epoch.value,
    profileId: profile?.id ?? null,
    packId: profile?.packId ?? null,
    packFormatVersion: EPHEMERIS_PACK_VERSION,
  });
}

// スナップショットの暦情報が、いまのカタログで復元できるか。**元期は照合しない** —
// 元期はそのランを定義する値で、読み込む側がそれを継ぐ。照合するのは「その元期が選ぶ
// 暦データが、いま手元にあるものと同じか」だけ。
export function isEphemerisContextRestorable(saved: unknown): boolean {
  if (saved === undefined) return true;
  if (!isValidContext(saved)) return false;
  return isEphemerisContextCompatible(saved, ephemerisContextFor(createJulianDate('TDB', saved.epochJdTdb)));
}

type EphemerisContextStatus = 'legacy' | 'compatible' | 'incompatible';

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

// 暦プロファイル/暦パックの識別子。数値暦を持たない時代では null。
function isProfileRef(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0);
}

function isValidContext(value: unknown): value is EphemerisContextValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  return isFiniteNumber(context.epochJdTdb) &&
    isProfileRef(context.profileId) &&
    isProfileRef(context.packId) &&
    typeof context.packFormatVersion === 'number' &&
    Number.isSafeInteger(context.packFormatVersion) &&
    context.packFormatVersion > 0;
}

export function ephemerisContextStatus(
  saved: unknown,
  current: Readonly<EphemerisContextValue>,
): EphemerisContextStatus {
  // Absence is the explicitly supported legacy migration path. null and any
  // malformed value are explicit-but-invalid context and must not be treated
  // as legacy data.
  if (saved === undefined) return 'legacy';
  if (!isValidContext(saved)) return 'incompatible';

  // 元期は継承する値なので比べない(SAVE.md「読み込み」)。
  return saved.profileId === current.profileId &&
    saved.packId === current.packId &&
    saved.packFormatVersion === current.packFormatVersion
    ? 'compatible'
    : 'incompatible';
}

export function isEphemerisContextCompatible(
  saved: unknown,
  current: Readonly<EphemerisContextValue>,
): boolean {
  return ephemerisContextStatus(saved, current) !== 'incompatible';
}
