import { KinematicState } from '../kinematic-state';

// An ArrayLike view keeps the evaluator independent of how coefficients arrived:
// plain arrays, typed arrays, and other indexed coefficient stores are all valid.
// The evaluator never writes through this interface.
export type ReadonlyNumberArray = {
  readonly length: number;
  readonly [index: number]: number;
};

export type ChebyshevVectorCoefficients = readonly [
  ReadonlyNumberArray,
  ReadonlyNumberArray,
  ReadonlyNumberArray,
];

export interface ChebyshevSegmentManifest {
  readonly start: number;
  readonly end: number;
  readonly degree?: number;
}

export interface ChebyshevBodyManifest {
  readonly id: string;
  readonly segments: readonly ChebyshevSegmentManifest[];
}

// Segment times are SI seconds and coefficient values are SI metres. The
// evaluator's public stateAtSeconds/stateOf methods take seconds on this same
// time axis; Julian dates are deliberately kept out of this binary-independent
// core and belong at an explicit adapter boundary.
export interface ChebyshevManifest {
  readonly version: number;
  readonly bodies: readonly ChebyshevBodyManifest[];
  readonly timeUnit: 's';
  readonly positionUnit: 'm';
  // Optional on the generic evaluator; required by the AbsoluteEphemeris adapter.
  readonly coordinateFrame?: 'ICRF-J2000';
  readonly timeScale?: 'TDB';
}

export interface ChebyshevSegment {
  readonly start: number;
  readonly end: number;
  readonly coefficients: ChebyshevVectorCoefficients;
}

export interface ChebyshevBodyPack {
  readonly id: string;
  readonly segments: readonly ChebyshevSegment[];
}

export interface ChebyshevEphemerisPack {
  readonly manifest: ChebyshevManifest;
  readonly bodies: readonly ChebyshevBodyPack[];
}

export interface ChebyshevEvaluation {
  readonly state: KinematicState<'barycentric'>;
  readonly segment: ChebyshevSegment;
  readonly segmentIndex: number;
}
