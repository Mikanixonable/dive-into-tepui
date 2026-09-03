import { EPHEMERIS_PACK_VERSION } from './pack-format';
import { profileAtOrNull } from './profile';
import { createJulianDate, TdbJulianDate } from '../time';

// スナップショットが「どの元期・どの暦プロファイル・どの pack で作られたか」。
// この形のまま GameSaveData の1フィールドとして保存される。
export interface EphemerisContext {
  // このランの元期(simTime=0 が指す絶対時刻)。**照合の対象ではなく、継承する値。**
  epochJdTdb: number;
  // その元期が選ぶ暦プロファイルと暦パック。数値暦を持たない時代では両方 null。
  profileId: string | null;
  packId: string | null;
  packFormatVersion: number;
}

// その元期がいま選ぶ暦の素性。暦係数そのものではなくカタログの鍵を持つので、
// パックを差し替えても保存された値は変わらない。
export function ephemerisContextFor(epoch: TdbJulianDate): Readonly<EphemerisContext> {
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

// 'legacy' は暦情報を持たない古いスナップショット。'compatible' はそのまま復元してよい。
type EphemerisContextStatus = 'legacy' | 'compatible' | 'incompatible';

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

// 暦プロファイル/暦パックの識別子。数値暦を持たない時代では null。
function isProfileRef(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0);
}

// 保存された値が暦情報の形を満たしているか。欠けや型違いがあれば偽。
function isValidContext(value: unknown): value is EphemerisContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  return isFiniteNumber(context.epochJdTdb) &&
    isProfileRef(context.profileId) &&
    isProfileRef(context.packId) &&
    typeof context.packFormatVersion === 'number' &&
    Number.isSafeInteger(context.packFormatVersion) &&
    context.packFormatVersion > 0;
}

// 保存された暦情報を current と照合した結果。
export function ephemerisContextStatus(
  saved: unknown,
  current: Readonly<EphemerisContext>,
): EphemerisContextStatus {
  // 不在だけが移行経路。null や壊れた値は「暦情報を持つが読めない」ので legacy へ寄せない。
  if (saved === undefined) return 'legacy';
  if (!isValidContext(saved)) return 'incompatible';

  // 元期は継承する値なので比べない(SAVE.md「読み込み」)。
  return saved.profileId === current.profileId &&
    saved.packId === current.packId &&
    saved.packFormatVersion === current.packFormatVersion
    ? 'compatible'
    : 'incompatible';
}

// legacy と compatible をまとめて「復元してよい」と答える。
export function isEphemerisContextCompatible(
  saved: unknown,
  current: Readonly<EphemerisContext>,
): boolean {
  return ephemerisContextStatus(saved, current) !== 'incompatible';
}
