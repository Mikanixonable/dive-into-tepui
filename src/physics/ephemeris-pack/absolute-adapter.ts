import {
  AbsoluteEphemeris,
  BarycentricState,
  MissingEphemerisBodyError,
} from '../absolute-ephemeris';
import { AttractorId } from '../attractor';
import { ChebyshevEphemeris, InvalidChebyshevPackError } from './evaluator';

export const SECONDS_PER_DAY = 86400;

export function secondsSinceEpochFromJdTdb(jdTdb: number, epochJdTdb: number): number {
  if (!Number.isFinite(jdTdb) || !Number.isFinite(epochJdTdb)) {
    throw new RangeError('JD TDB and epoch JD TDB must be finite');
  }
  return (jdTdb - epochJdTdb) * SECONDS_PER_DAY;
}

export function jdTdbFromSecondsSinceEpoch(secondsSinceEpoch: number, epochJdTdb: number): number {
  if (!Number.isFinite(secondsSinceEpoch) || !Number.isFinite(epochJdTdb)) {
    throw new RangeError('seconds since epoch and epoch JD TDB must be finite');
  }
  return epochJdTdb + secondsSinceEpoch / SECONDS_PER_DAY;
}

// Explicit JD-TDB adapter for packs whose coefficients are barycentric ICRF/J2000
// metres. The core evaluator remains seconds-based and does not silently interpret
// a Julian date as seconds or perform a frame conversion.
export class ChebyshevAbsoluteEphemeris implements AbsoluteEphemeris {
  readonly validStartJdTdb: number;
  readonly validEndJdTdb: number;

  constructor(
    private readonly evaluator: ChebyshevEphemeris,
    readonly epochJdTdb: number,
  ) {
    if (!Number.isFinite(epochJdTdb)) throw new InvalidChebyshevPackError('epochJdTdb must be finite');
    // toEvaluatorEphemerisPack has already validated the canonical binary
    // manifest and intentionally retains only the core evaluator fields, so
    // omitted metadata is accepted here. If present, it must use the canonical
    // spelling and scale from that manifest.
    if (evaluator.manifest.coordinateFrame !== undefined && evaluator.manifest.coordinateFrame !== 'ICRF-J2000') {
      throw new InvalidChebyshevPackError('AbsoluteEphemeris adapter requires coordinateFrame ICRF-J2000');
    }
    if (evaluator.manifest.timeScale !== undefined && evaluator.manifest.timeScale !== 'TDB') {
      throw new InvalidChebyshevPackError('AbsoluteEphemeris adapter requires timeScale TDB');
    }
    const starts = evaluator.pack.bodies.map((body) => body.segments[0]!.start);
    const ends = evaluator.pack.bodies.map((body) => body.segments[body.segments.length - 1]!.end);
    this.validStartJdTdb = jdTdbFromSecondsSinceEpoch(Math.min(...starts), epochJdTdb);
    this.validEndJdTdb = jdTdbFromSecondsSinceEpoch(Math.max(...ends), epochJdTdb);
  }

  hasBody(id: AttractorId): boolean {
    return this.evaluator.bodyIds().includes(id);
  }

  barycentricStateOf(id: AttractorId, jdTdb: number): BarycentricState {
    if (!this.hasBody(id)) throw new MissingEphemerisBodyError(id);
    const state = this.evaluator.stateAtSeconds(id, secondsSinceEpochFromJdTdb(jdTdb, this.epochJdTdb));
    return { r: state.r, v: state.v };
  }
}
