import { AbsoluteEphemeris, BarycentricState } from './absolute-ephemeris';
import { AttractorId } from './attractor';
import { ChebyshevEphemeris } from './ephemeris-pack';
import {
  DecodedEphemerisPack, EphemerisPackFormatError, decodeEphemerisPack, toEvaluatorEphemerisPack,
} from './ephemeris-pack/format';
import { J2000_JULIAN_DATE, SECONDS_PER_DAY } from './time';

// バイナリpackのJ2000 ET秒を、ゲーム共通のJD_TDB入力へ適合させる。
// payload SHA-256は非同期loaderが検証する。同期コンストラクタは既に信頼済みのbytesだけを受ける。
export class PackedAbsoluteEphemeris implements AbsoluteEphemeris {
  readonly validStartJdTdb: number;
  readonly validEndJdTdb: number;
  private readonly evaluator: ChebyshevEphemeris;
  private readonly ids: ReadonlySet<string>;

  constructor(readonly decoded: DecodedEphemerisPack) {
    this.validStartJdTdb = J2000_JULIAN_DATE + decoded.manifest.validStart / SECONDS_PER_DAY;
    this.validEndJdTdb = J2000_JULIAN_DATE + decoded.manifest.validEnd / SECONDS_PER_DAY;
    this.evaluator = new ChebyshevEphemeris(toEvaluatorEphemerisPack(decoded));
    this.ids = new Set(this.evaluator.bodyIds());
  }

  static fromTrustedBytes(bytes: Uint8Array): PackedAbsoluteEphemeris {
    return new PackedAbsoluteEphemeris(decodeEphemerisPack(bytes));
  }

  hasBody(id: AttractorId): boolean {
    return this.ids.has(id);
  }

  barycentricStateOf(id: AttractorId, jdTdb: number): BarycentricState {
    if (!Number.isFinite(jdTdb)) throw new RangeError(`JD_TDBは有限値でなければならない: ${jdTdb}`);
    const et = (jdTdb - J2000_JULIAN_DATE) * SECONDS_PER_DAY;
    const state = this.evaluator.stateAtSeconds(id, et);
    return { r: state.r, v: state.v };
  }
}

export async function verifyEphemerisPayload(decoded: DecodedEphemerisPack): Promise<void> {
  const expected = decoded.manifest.payloadSha256;
  if (expected === undefined) throw new EphemerisPackFormatError('payloadSha256が無い暦packは読み込めない');
  if (!globalThis.crypto?.subtle) throw new EphemerisPackFormatError('SHA-256を検証できない実行環境');
  const bytes = decoded.payloadBytes as Uint8Array<ArrayBuffer>;
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  const actual = [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
  if (actual !== expected) throw new EphemerisPackFormatError(
    `payload SHA-256不一致: expected ${expected}, actual ${actual}`,
  );
}

export async function loadPackedAbsoluteEphemeris(bytes: Uint8Array): Promise<PackedAbsoluteEphemeris> {
  const decoded = decodeEphemerisPack(bytes);
  await verifyEphemerisPayload(decoded);
  return new PackedAbsoluteEphemeris(decoded);
}
