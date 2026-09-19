import { EPHEMERIS_PACK_VERSION } from './pack-format';
import { profileAtOrNull } from './profile';
import { createJulianDate, TdbJulianDate } from '../time';

// スナップショットが「どの元期・どの暦プロファイル・どの pack で作られたか」。
// JSON の素の値だけから成り、この形のまま直列化の形を兼ねる。
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
// 元期はそのランを定義する値で、読み込む側がそれを継ぐ(SAVE.md「読み込み」)。照合するのは
// 「その元期が選ぶ暦データが、いま手元にあるものと同じか」。
export function isEphemerisContextRestorable(saved: unknown): boolean {
  if (!isValidContext(saved)) return false;
  const current = ephemerisContextFor(createJulianDate('TDB', saved.epochJdTdb));
  return saved.profileId === current.profileId &&
    saved.packId === current.packId &&
    saved.packFormatVersion === current.packFormatVersion;
}

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
