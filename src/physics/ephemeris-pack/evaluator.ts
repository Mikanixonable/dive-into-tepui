import { KinematicState, kinematicState } from '../kinematic-state';
import { Vec3, v3 } from '../../math/vec3';
import {
  ChebyshevBodyPack,
  ChebyshevEphemerisPack,
  ChebyshevEvaluation,
  ChebyshevSegment,
  ChebyshevVectorCoefficients,
  ReadonlyNumberArray,
} from './types';

export class InvalidChebyshevPackError extends Error {
  constructor(message: string) {
    super(`Invalid Chebyshev ephemeris pack: ${message}`);
    this.name = 'InvalidChebyshevPackError';
  }
}

export class ChebyshevBodyNotFoundError extends Error {
  readonly bodyId: string;

  constructor(bodyId: string) {
    super(`Chebyshev ephemeris body not found: ${bodyId}`);
    this.name = 'ChebyshevBodyNotFoundError';
    this.bodyId = bodyId;
  }
}

export class ChebyshevTimeOutOfRangeError extends RangeError {
  readonly bodyId: string;
  readonly time: number;
  readonly start: number;
  readonly end: number;

  constructor(bodyId: string, time: number, start: number, end: number) {
    super(`Chebyshev ephemeris time ${time} is outside ${bodyId}'s validity [${start}, ${end}]`);
    this.name = 'ChebyshevTimeOutOfRangeError';
    this.bodyId = bodyId;
    this.time = time;
    this.start = start;
    this.end = end;
  }
}

export interface ChebyshevValueAndDerivative {
  readonly value: number;
  readonly derivative: number;
}

// Evaluate sum(c[k] T_k(x)) and its analytic derivative with one Clenshaw
// recurrence. The derivative is with respect to the normalized x coordinate.
export function evaluateChebyshevWithDerivative(
  coefficients: ReadonlyNumberArray,
  x: number,
): ChebyshevValueAndDerivative {
  if (!Number.isFinite(x)) throw new RangeError(`Chebyshev coordinate must be finite: ${x}`);
  if (!Number.isInteger(coefficients.length) || coefficients.length < 1) {
    throw new RangeError('Chebyshev coefficients must contain at least one value');
  }

  let b1 = 0;
  let b2 = 0;
  let db1 = 0;
  let db2 = 0;
  for (let k = coefficients.length - 1; k >= 1; k--) {
    const coefficient = coefficients[k];
    if (coefficient === undefined || !Number.isFinite(coefficient)) {
      throw new RangeError(`Chebyshev coefficient ${k} must be finite`);
    }
    const b0 = 2 * x * b1 - b2 + coefficient;
    const db0 = 2 * b1 + 2 * x * db1 - db2;
    b2 = b1;
    b1 = b0;
    db2 = db1;
    db1 = db0;
  }

  const constant = coefficients[0];
  if (constant === undefined || !Number.isFinite(constant)) {
    throw new RangeError('Chebyshev coefficient 0 must be finite');
  }
  return {
    value: x * b1 - b2 + constant,
    derivative: b1 + x * db1 - db2,
  };
}

// Segments are half-open except that the final segment includes its end. At a
// shared boundary the later segment is selected, making the lookup deterministic.
export function findChebyshevSegmentIndex(segments: readonly ChebyshevSegment[], time: number): number {
  if (!Number.isFinite(time)) throw new RangeError(`Chebyshev time must be finite: ${time}`);
  if (segments.length === 0) throw new InvalidChebyshevPackError('a body must contain a segment');

  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const segment = segments[middle]!;
    if (time < segment.start) {
      high = middle - 1;
    } else if (time >= segment.end && middle < segments.length - 1) {
      low = middle + 1;
    } else if (time <= segment.end) {
      return middle;
    } else {
      low = middle + 1;
    }
  }
  return -1;
}

interface IndexedBody {
  readonly body: ChebyshevBodyPack;
  readonly starts: readonly number[];
}

function copyCoefficients(coefficients: ReadonlyNumberArray, label: string): ReadonlyNumberArray {
  if (!Number.isInteger(coefficients.length) || coefficients.length < 1) {
    throw new InvalidChebyshevPackError(`${label} must contain at least one coefficient`);
  }
  const copy: number[] = [];
  for (let i = 0; i < coefficients.length; i++) {
    const value = coefficients[i];
    if (value === undefined || !Number.isFinite(value)) {
      throw new InvalidChebyshevPackError(`${label}[${i}] must be finite`);
    }
    copy.push(value);
  }
  return Object.freeze(copy);
}

function copySegment(segment: ChebyshevSegment, bodyId: string, index: number): ChebyshevSegment {
  if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.end <= segment.start) {
    throw new InvalidChebyshevPackError(
      `${bodyId} segment ${index} must have finite start < end`,
    );
  }
  const [x, y, z] = segment.coefficients;
  if (x === undefined || y === undefined || z === undefined) {
    throw new InvalidChebyshevPackError(`${bodyId} segment ${index} must have x/y/z coefficients`);
  }
  if (x.length !== y.length || x.length !== z.length) {
    throw new InvalidChebyshevPackError(`${bodyId} segment ${index} coefficient lengths must match`);
  }
  return Object.freeze({
    start: segment.start,
    end: segment.end,
    coefficients: Object.freeze([
      copyCoefficients(x, `${bodyId} segment ${index} x`),
      copyCoefficients(y, `${bodyId} segment ${index} y`),
      copyCoefficients(z, `${bodyId} segment ${index} z`),
    ]) as unknown as ChebyshevVectorCoefficients,
  });
}

function copyBody(body: ChebyshevBodyPack): ChebyshevBodyPack {
  if (body.id.length === 0) throw new InvalidChebyshevPackError('body id must not be empty');
  const segments = body.segments.map((segment, index) => copySegment(segment, body.id, index));
  for (let i = 1; i < segments.length; i++) {
    const previous = segments[i - 1]!;
    const current = segments[i]!;
    if (current.start < previous.end) {
      throw new InvalidChebyshevPackError(`${body.id} segments overlap at index ${i}`);
    }
  }
  if (segments.length === 0) throw new InvalidChebyshevPackError(`${body.id} must contain a segment`);
  return Object.freeze({ id: body.id, segments: Object.freeze(segments) });
}

function validateManifest(pack: ChebyshevEphemerisPack, bodies: readonly ChebyshevBodyPack[]): void {
  if (!Number.isFinite(pack.manifest.version) || pack.manifest.version < 1) {
    throw new InvalidChebyshevPackError('manifest version must be a positive number');
  }
  if (pack.manifest.timeUnit !== 's') throw new InvalidChebyshevPackError('manifest timeUnit must be s');
  if (pack.manifest.positionUnit !== 'm') throw new InvalidChebyshevPackError('manifest positionUnit must be m');
  const manifestIds = new Set<string>();
  for (const manifestBody of pack.manifest.bodies) {
    if (manifestIds.has(manifestBody.id)) {
      throw new InvalidChebyshevPackError(`manifest contains duplicate body ${manifestBody.id}`);
    }
    manifestIds.add(manifestBody.id);
  }
  if (manifestIds.size !== bodies.length) {
    throw new InvalidChebyshevPackError('manifest and body pack counts do not match');
  }
  for (const body of bodies) {
    const manifestBody = pack.manifest.bodies.find((candidate) => candidate.id === body.id);
    if (manifestBody === undefined) {
      throw new InvalidChebyshevPackError(`manifest has no entry for body ${body.id}`);
    }
    if (manifestBody.segments.length !== body.segments.length) {
      throw new InvalidChebyshevPackError(`${body.id} manifest segment count does not match pack`);
    }
    for (let i = 0; i < body.segments.length; i++) {
      const segment = body.segments[i]!;
      const metadata = manifestBody.segments[i]!;
      if (metadata.start !== segment.start || metadata.end !== segment.end) {
        throw new InvalidChebyshevPackError(`${body.id} segment ${i} time metadata does not match pack`);
      }
      if (metadata.degree !== undefined && metadata.degree !== segment.coefficients[0].length - 1) {
        throw new InvalidChebyshevPackError(`${body.id} segment ${i} degree does not match coefficients`);
      }
    }
  }
}

function evaluateSegment(segment: ChebyshevSegment, time: number): { position: Vec3; velocity: Vec3 } {
  const halfSpan = (segment.end - segment.start) / 2;
  const normalizedTime = (time - (segment.start + segment.end) / 2) / halfSpan;
  const scaleToSeconds = 1 / halfSpan;
  const [x, y, z] = segment.coefficients;
  const px = evaluateChebyshevWithDerivative(x, normalizedTime);
  const py = evaluateChebyshevWithDerivative(y, normalizedTime);
  const pz = evaluateChebyshevWithDerivative(z, normalizedTime);
  return {
    position: v3(px.value, py.value, pz.value),
    velocity: v3(
      px.derivative * scaleToSeconds,
      py.derivative * scaleToSeconds,
      pz.derivative * scaleToSeconds,
    ),
  };
}

export class ChebyshevEphemeris {
  readonly manifest: ChebyshevEphemerisPack['manifest'];
  readonly pack: ChebyshevEphemerisPack;
  private readonly bodiesById = new Map<string, IndexedBody>();

  constructor(input: ChebyshevEphemerisPack) {
    const bodies = input.bodies.map(copyBody);
    validateManifest(input, bodies);
    this.manifest = Object.freeze({
      ...input.manifest,
      bodies: Object.freeze(input.manifest.bodies.map((body) => Object.freeze({
        ...body,
        segments: Object.freeze(body.segments.map((segment) => Object.freeze({ ...segment }))),
      }))),
    });
    this.pack = Object.freeze({ manifest: this.manifest, bodies: Object.freeze(bodies) });

    for (const body of bodies) {
      if (this.bodiesById.has(body.id)) {
        throw new InvalidChebyshevPackError(`duplicate body ${body.id}`);
      }
      this.bodiesById.set(body.id, {
        body,
        starts: Object.freeze(body.segments.map((segment) => segment.start)),
      });
    }
  }

  bodyIds(): readonly string[] {
    return Object.freeze([...this.bodiesById.keys()]);
  }

  segmentOf(bodyId: string, time: number): { readonly segment: ChebyshevSegment; readonly index: number } {
    const indexed = this.bodiesById.get(bodyId);
    if (indexed === undefined) throw new ChebyshevBodyNotFoundError(bodyId);
    const index = findChebyshevSegmentIndex(indexed.body.segments, time);
    if (index < 0) {
      const first = indexed.body.segments[0]!;
      const last = indexed.body.segments[indexed.body.segments.length - 1]!;
      throw new ChebyshevTimeOutOfRangeError(bodyId, time, first.start, last.end);
    }
    return { segment: indexed.body.segments[index]!, index };
  }

  evaluate(bodyId: string, time: number): ChebyshevEvaluation {
    const selected = this.segmentOf(bodyId, time);
    const evaluated = evaluateSegment(selected.segment, time);
    return {
      state: kinematicState<'barycentric'>(time, evaluated.position, evaluated.velocity),
      segment: selected.segment,
      segmentIndex: selected.index,
    };
  }

  stateOf(bodyId: string, time: number): KinematicState<'barycentric'> {
    return this.evaluate(bodyId, time).state;
  }

  positionOf(bodyId: string, time: number): Vec3 {
    return this.evaluate(bodyId, time).state.r;
  }

  velocityOf(bodyId: string, time: number): Vec3 {
    return this.evaluate(bodyId, time).state.v;
  }
}
