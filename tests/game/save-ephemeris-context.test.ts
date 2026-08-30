import assert from 'node:assert/strict';
import {
  ephemerisContextFor,
  ephemerisContextStatus,
  isEphemerisContextCompatible,
} from '../../src/game/save/ephemeris-context';
import { EPHEMERIS_PROFILES } from '../../src/physics/ephemeris-profile';
import { createJulianDate } from '../../src/physics/time';
import { test } from '../harness';

// 検査するのは照合の規則そのものなので、元期はプロファイルが引ける値なら何でもよい。
const EPOCH = createJulianDate('TDB', EPHEMERIS_PROFILES['far-future-20000'].validStartJdTdb);
const CONTEXT = ephemerisContextFor(EPOCH);

export function register(): void {
  test('save ephemeris context: legacy snapshots remain compatible', () => {
    assert.equal(ephemerisContextStatus(undefined, CONTEXT), 'legacy');
    assert.equal(isEphemerisContextCompatible(undefined, CONTEXT), true);
  });

  test('save ephemeris context: current context is compatible', () => {
    assert.equal(ephemerisContextStatus({ ...CONTEXT }, CONTEXT), 'compatible');
  });

  test('save ephemeris context: explicit mismatches are incompatible', () => {
    assert.equal(
      ephemerisContextStatus({ ...CONTEXT, epochJdTdb: CONTEXT.epochJdTdb + 1 }, CONTEXT),
      'incompatible',
    );
    assert.equal(
      ephemerisContextStatus({ ...CONTEXT, profileId: 'modern-de440' }, CONTEXT),
      'incompatible',
    );
    assert.equal(
      ephemerisContextStatus({ ...CONTEXT, packId: 'different-pack' }, CONTEXT),
      'incompatible',
    );
    assert.equal(
      ephemerisContextStatus({ ...CONTEXT, packFormatVersion: 2 }, CONTEXT),
      'incompatible',
    );
  });

  test('save ephemeris context: malformed explicit values are incompatible', () => {
    assert.equal(ephemerisContextStatus(null, CONTEXT), 'incompatible');
    assert.equal(ephemerisContextStatus({ ...CONTEXT, packId: '' }, CONTEXT), 'incompatible');
    assert.equal(isEphemerisContextCompatible({ epochJdTdb: CONTEXT.epochJdTdb }, CONTEXT), false);
  });
}
