import { AbsoluteEphemeris, BarycentricState } from './absolute-ephemeris';
import { ChebyshevEphemeris } from './ephemeris-pack/evaluator';
import {
  DecodedEphemerisPack, EphemerisPackFormatError, decodeEphemerisPack, toEvaluatorEphemerisPack,
} from './ephemeris-pack/format';
import { ephemerisSeconds, TdbJulianDate } from './time';

// バイナリ pack の J2000 ET 秒を、構築時に一度だけ元期起点の simTime へ寄せる。**ET 秒が
// 外へ出るのはここまで** — 有効期間も評価の引数も simTime で話す。寄せる理由は2つで、
// 評価のたびに巨大な定数を足し直さずに済むことと、遠未来の元期では ET 秒の ULP が
// 1.2e-4 s あって要求した時刻がそのまま honor されないこと。
// payload SHA-256は非同期loaderが検証する。同期コンストラクタは既に信頼済みのbytesだけを受ける。
export class PackedAbsoluteEphemeris implements AbsoluteEphemeris {
  readonly validStartSimTime: number;
  readonly validEndSimTime: number;
  private readonly evaluator: ChebyshevEphemeris;
  private readonly ids: ReadonlySet<string>;

  constructor(readonly decoded: DecodedEphemerisPack, epoch: TdbJulianDate) {
    const simZeroEt = ephemerisSeconds(epoch);
    this.validStartSimTime = decoded.manifest.validStart - simZeroEt;
    this.validEndSimTime = decoded.manifest.validEnd - simZeroEt;
    this.evaluator = new ChebyshevEphemeris(toEvaluatorEphemerisPack(decoded, simZeroEt));
    this.ids = new Set(this.evaluator.bodyIds());
  }

  static fromTrustedBytes(bytes: Uint8Array, epoch: TdbJulianDate): PackedAbsoluteEphemeris {
    return new PackedAbsoluteEphemeris(decodeEphemerisPack(bytes), epoch);
  }

  hasBody(id: string): boolean {
    return this.ids.has(id);
  }

  barycentricStateOf(id: string, simTime: number): BarycentricState {
    if (!Number.isFinite(simTime)) throw new RangeError(`simTime は有限値でなければならない: ${simTime}`);
    const state = this.evaluator.stateOf(id, simTime);
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

export async function loadPackedAbsoluteEphemeris(
  bytes: Uint8Array, epoch: TdbJulianDate,
): Promise<PackedAbsoluteEphemeris> {
  const decoded = decodeEphemerisPack(bytes);
  await verifyEphemerisPayload(decoded);
  return new PackedAbsoluteEphemeris(decoded, epoch);
}
