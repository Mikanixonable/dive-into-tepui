// An ArrayLike view keeps the evaluator independent of how coefficients arrived:
// plain arrays, typed arrays, and other indexed coefficient stores are all valid.
// The evaluator never writes through this interface.
export type ReadonlyNumberArray = {
  readonly length: number;
  readonly [index: number]: number;
};

type ChebyshevVectorCoefficients = readonly [
  ReadonlyNumberArray,
  ReadonlyNumberArray,
  ReadonlyNumberArray,
];

interface ChebyshevSegmentManifest {
  readonly start: number;
  readonly end: number;
  readonly degree?: number;
}

interface ChebyshevBodyManifest {
  readonly id: string;
  readonly segments: readonly ChebyshevSegmentManifest[];
}

// 区間時刻は秒 [s]、係数はメートル [m]。評価器は同一の時間軸を受け取り、
// 原点のアンカー位置は関知しない。ユリウス日はアダプタ境界側で扱う。
interface ChebyshevManifest {
  readonly version: number;
  readonly bodies: readonly ChebyshevBodyManifest[];
  readonly timeUnit: 's';
  readonly positionUnit: 'm';
}

export interface ChebyshevSegment {
  readonly start: number;
  readonly end: number;
  readonly coefficients: ChebyshevVectorCoefficients;
}

export interface ChebyshevBodySegments {
  readonly id: string;
  readonly segments: readonly ChebyshevSegment[];
}

export interface ChebyshevPack {
  readonly manifest: ChebyshevManifest;
  readonly bodies: readonly ChebyshevBodySegments[];
}
