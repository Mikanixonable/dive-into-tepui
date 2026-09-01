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

// Segment times are SI seconds and coefficient values are SI metres. The
// evaluator takes seconds on this same time axis and does not know where that
// axis is anchored — whoever built the pack chose the origin. Julian dates are
// deliberately kept out of this binary-independent core and belong at an
// explicit adapter boundary.
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
