import assert from 'node:assert/strict';
import {
  CURRENT_EPHEMERIS_CONTEXT,
  ephemerisContextStatus,
  isEphemerisContextCompatible,
} from '../../src/game/save/ephemeris-context';
import { test } from '../harness';

export function register(): void {
  test('save ephemeris context: legacy snapshots remain compatible', () => {
    assert.equal(ephemerisContextStatus(undefined), 'legacy');
    assert.equal(isEphemerisContextCompatible(undefined), true);
  });

  test('save ephemeris context: current context is compatible', () => {
    assert.equal(ephemerisContextStatus({ ...CURRENT_EPHEMERIS_CONTEXT }), 'compatible');
  });

  test('save ephemeris context: explicit mismatches are incompatible', () => {
    assert.equal(
      ephemerisContextStatus({ ...CURRENT_EPHEMERIS_CONTEXT, epochJdTdb: CURRENT_EPHEMERIS_CONTEXT.epochJdTdb + 1 }),
      'incompatible',
    );
    assert.equal(
      ephemerisContextStatus({ ...CURRENT_EPHEMERIS_CONTEXT, profileId: 'modern-de440' }),
      'incompatible',
    );
    assert.equal(
      ephemerisContextStatus({ ...CURRENT_EPHEMERIS_CONTEXT, packId: 'different-pack' }),
      'incompatible',
    );
    assert.equal(
      ephemerisContextStatus({ ...CURRENT_EPHEMERIS_CONTEXT, packFormatVersion: 2 }),
      'incompatible',
    );
  });

  test('save ephemeris context: malformed explicit values are incompatible', () => {
    assert.equal(ephemerisContextStatus(null), 'incompatible');
    assert.equal(ephemerisContextStatus({ ...CURRENT_EPHEMERIS_CONTEXT, packId: '' }), 'incompatible');
    assert.equal(isEphemerisContextCompatible({ epochJdTdb: CURRENT_EPHEMERIS_CONTEXT.epochJdTdb }), false);
  });
}
