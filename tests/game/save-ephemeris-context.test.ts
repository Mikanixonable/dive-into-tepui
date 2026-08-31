import assert from 'node:assert/strict';
import {
  ephemerisContextFor,
  ephemerisContextStatus,
  isEphemerisContextCompatible,
  isEphemerisContextRestorable,
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

  // 元期はそのランを定義する値で、読み込む側が継ぐ(SAVE.md「読み込み」)。
  test('save ephemeris context: 元期の違いは読み込みを妨げない', () => {
    assert.equal(
      ephemerisContextStatus({ ...CONTEXT, epochJdTdb: CONTEXT.epochJdTdb + 1 }, CONTEXT),
      'compatible',
    );
    // 同じプロファイル期間の別の元期で保存されたスナップショットは、そのまま読める。
    const other = ephemerisContextFor(createJulianDate('TDB', EPOCH.value + 100));
    assert.equal(isEphemerisContextRestorable({ ...other }), true);
  });

  // 数値暦を持たない時代(解析暦だけで組む)を元期にしたランも保存・復元できる。
  test('save ephemeris context: 数値暦の無い元期でも暦情報を組めて復元できる', () => {
    const analyticOnly = ephemerisContextFor(createJulianDate('TDB', 2451545));
    assert.equal(analyticOnly.profileId, null);
    assert.equal(analyticOnly.packId, null);
    assert.equal(isEphemerisContextRestorable({ ...analyticOnly }), true);
    // 暦データそのものが食い違えば、元期に関わらず拒否する。
    assert.equal(isEphemerisContextRestorable({ ...CONTEXT, packId: 'different-pack' }), false);
  });

  test('save ephemeris context: malformed explicit values are incompatible', () => {
    assert.equal(ephemerisContextStatus(null, CONTEXT), 'incompatible');
    assert.equal(ephemerisContextStatus({ ...CONTEXT, packId: '' }, CONTEXT), 'incompatible');
    assert.equal(isEphemerisContextCompatible({ epochJdTdb: CONTEXT.epochJdTdb }, CONTEXT), false);
  });
}
