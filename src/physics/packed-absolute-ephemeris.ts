import { AbsoluteEphemeris, EphemerisPointKind, icrfToGameEci } from './absolute-ephemeris';
import { BodyEphemeris } from './body-ephemeris';
import { ChebyshevEphemeris } from './ephemeris-pack/evaluator';
import { KinematicState, kinematicState } from './kinematic-state';
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
  private readonly evaluator: ChebyshevEphemeris;
  private readonly bodyPoints: Readonly<Record<string, EphemerisPointKind>>;

  // pack が実際に覆う絶対時刻の範囲(J2000 ET 秒)。**catalog が要求期間との被覆を判定する。**
  readonly validStartEt: number;
  readonly validEndEt: number;
  // payload の SHA-256。catalog が profile の packId と突き合わせる。
  readonly payloadSha256: string | undefined;

  // **decoded は保持しない。** 係数は評価器が payload へのビューとして持ち、ここで要るのは
  // manifest のごく一部だけ — 抱えたままにすると manifestJson(2.2 MB)と 10054 個の series
  // オブジェクトが pack と同じ寿命で残る。
  constructor(decoded: DecodedEphemerisPack, epoch: TdbJulianDate) {
    this.evaluator = new ChebyshevEphemeris(
      toEvaluatorEphemerisPack(decoded, ephemerisSeconds(epoch)));
    this.bodyPoints = decoded.manifest.bodyPoints ?? {};
    this.validStartEt = decoded.manifest.validStart;
    this.validEndEt = decoded.manifest.validEnd;
    this.payloadSha256 = decoded.manifest.payloadSha256;
  }

  static fromTrustedBytes(bytes: Uint8Array, epoch: TdbJulianDate): PackedAbsoluteEphemeris {
    return new PackedAbsoluteEphemeris(decodeEphemerisPack(bytes), epoch);
  }

  // 天体 id が収録している点。manifest が宣言していない id は天体本体。
  pointKindOf(id: string): EphemerisPointKind {
    return this.bodyPoints[id] ?? 'body';
  }

  // 天体 id の1体ぶんを切り出した暦。有効期間はその天体自身のセグメント範囲。
  // 収録していなければ null。
  bodyEphemerisOf(id: string): BodyEphemeris | null {
    const range = this.evaluator.validRangeOf(id);
    if (range === null) return null;
    return new PackedBodyEphemeris(this.evaluator, id, range.start, range.end);
  }
}

// 評価器の1天体ぶんを BodyEphemeris として見せる窓。id を構築時に固定し、ICRF 軸を
// ゲーム ECI 軸へ写す。原点は太陽系重心のまま。
class PackedBodyEphemeris implements BodyEphemeris {
  constructor(
    private readonly evaluator: ChebyshevEphemeris,
    private readonly id: string,
    readonly validStartSimTime: number,
    readonly validEndSimTime: number,
  ) {}

  stateAt(simTime: number): KinematicState<'packed'> {
    if (!Number.isFinite(simTime)) throw new RangeError(`simTime は有限値でなければならない: ${simTime}`);
    const state = this.evaluator.stateOf(this.id, simTime);
    return kinematicState<'packed'>(simTime, icrfToGameEci(state.r), icrfToGameEci(state.v));
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
