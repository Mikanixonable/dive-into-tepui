import { icrfToGameEci } from './icrf';
import { EphemerisPointKind, EphemerisPoints, PointEphemeris } from './point-ephemeris';
import { ChebyshevEphemeris } from './ephemeris-pack/evaluator';
import { KinematicState, kinematicState } from './kinematic-state';
import {
  DecodedPack, PackFormatError, decodePack, toChebyshevPack,
} from './ephemeris-pack/format';
import { ephemerisSeconds, TdbJulianDate } from './time';

// バイナリ pack の J2000 ET 秒を、構築時に一度だけ元期起点の simTime へ寄せる。**ET 秒が
// 外へ出るのはここまで** — 有効期間も評価の引数も simTime で話す。寄せる理由は2つで、
// 評価のたびに巨大な定数を足し直さずに済むことと、遠未来の元期では ET 秒の ULP が
// 1.2e-4 s あって要求した時刻がそのまま honor されないこと。
// payload SHA-256は非同期loaderが検証する。同期コンストラクタは既に信頼済みのbytesだけを受ける。
export class PackEphemeris {
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
  constructor(decoded: DecodedPack, epoch: TdbJulianDate) {
    this.evaluator = new ChebyshevEphemeris(
      toChebyshevPack(decoded, ephemerisSeconds(epoch)));
    this.bodyPoints = decoded.manifest.bodyPoints ?? {};
    this.validStartEt = decoded.manifest.validStart;
    this.validEndEt = decoded.manifest.validEnd;
    this.payloadSha256 = decoded.manifest.payloadSha256;
  }

  static fromTrustedBytes(bytes: Uint8Array, epoch: TdbJulianDate): PackEphemeris {
    return new PackEphemeris(decodePack(bytes), epoch);
  }

  // 収録している全 id ぶんの暦と種別を1度で組む。**これが供給源の外向きの形** —
  // 引く側は id と種別で問い合わせ直さず、解決済みの一覧を受け取る。
  ephemerisPoints(): EphemerisPoints {
    const points = new Map<string, { kind: EphemerisPointKind; ephemeris: PointEphemeris }>();
    for (const id of this.evaluator.bodyIds) {
      const ephemeris = this.pointEphemerisOf(id);
      if (ephemeris !== null) points.set(id, { kind: this.pointKindOf(id), ephemeris });
    }
    return points;
  }

  // 天体 id が収録している点。manifest が宣言していない id は天体本体。
  private pointKindOf(id: string): EphemerisPointKind {
    return this.bodyPoints[id] ?? 'body';
  }

  // 天体 id が収録している点1つぶんを切り出した暦。有効期間はその系列のセグメント範囲。
  // 収録していなければ null。
  private pointEphemerisOf(id: string): PointEphemeris | null {
    const range = this.evaluator.validRangeOf(id);
    if (range === null) return null;
    return new ChebyshevPointEphemeris(this.evaluator, id, range.start, range.end);
  }
}

// 評価器の1系列ぶんを PointEphemeris として見せる窓。id を構築時に固定し、ICRF 軸を
// ゲーム ECI 軸へ写す。原点は太陽系重心のまま。
class ChebyshevPointEphemeris implements PointEphemeris {
  constructor(
    private readonly evaluator: ChebyshevEphemeris,
    private readonly id: string,
    readonly validStartSimTime: number,
    readonly validEndSimTime: number,
  ) {}

  baryStateAt(simTime: number): KinematicState<'numeric'> {
    if (!Number.isFinite(simTime)) throw new RangeError(`simTime は有限値でなければならない: ${simTime}`);
    const state = this.evaluator.icrfStateAt(this.id, simTime);
    return kinematicState<'numeric'>(simTime, icrfToGameEci(state.r), icrfToGameEci(state.v));
  }
}

export async function verifyEphemerisPayload(decoded: DecodedPack): Promise<void> {
  const expected = decoded.manifest.payloadSha256;
  if (expected === undefined) throw new PackFormatError('payloadSha256が無い暦packは読み込めない');
  if (!globalThis.crypto?.subtle) throw new PackFormatError('SHA-256を検証できない実行環境');
  const bytes = decoded.payloadBytes as Uint8Array<ArrayBuffer>;
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  const actual = [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
  if (actual !== expected) throw new PackFormatError(
    `payload SHA-256不一致: expected ${expected}, actual ${actual}`,
  );
}

export async function loadPackEphemeris(
  bytes: Uint8Array, epoch: TdbJulianDate,
): Promise<PackEphemeris> {
  const decoded = decodePack(bytes);
  await verifyEphemerisPayload(decoded);
  return new PackEphemeris(decoded, epoch);
}
