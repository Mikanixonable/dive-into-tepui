import assert from 'node:assert/strict';
import {
  ephemerisContextFor,
  isEphemerisContextRestorable,
} from '../../src/physics/ephemeris/ephemeris-context';
import { EPHEMERIS_PROFILES } from '../../src/physics/ephemeris/profile';
import { createJulianDate } from '../../src/physics/time';
import { test } from '../harness';

// 検査するのは照合の規則そのものなので、元期はプロファイルが引ける値なら何でもよい。
const EPOCH = createJulianDate('TDB', EPHEMERIS_PROFILES['far-future-20000'].validStartJdTdb);
const CONTEXT = ephemerisContextFor(EPOCH);

export function register(): void {
  test('save ephemeris context: いま組める暦情報はそのまま復元できる', () => {
    assert.equal(isEphemerisContextRestorable({ ...CONTEXT }), true);
  });

  test('save ephemeris context: 暦データの食い違いは復元できない', () => {
    assert.equal(isEphemerisContextRestorable({ ...CONTEXT, profileId: 'modern-de440' }), false);
    assert.equal(isEphemerisContextRestorable({ ...CONTEXT, packId: 'different-pack' }), false);
    assert.equal(isEphemerisContextRestorable({ ...CONTEXT, packFormatVersion: 2 }), false);
  });

  // 元期はそのランを定義する値で、読み込む側が継ぐ(SAVE.md「読み込み」)。
  test('save ephemeris context: 元期の違いは読み込みを妨げない', () => {
    const other = ephemerisContextFor(createJulianDate('TDB', EPOCH.value + 100));
    assert.notEqual(other.epochJdTdb, CONTEXT.epochJdTdb);
    assert.equal(isEphemerisContextRestorable({ ...other }), true);
  });

  // 数値暦を持たない時代(解析暦だけで組む)を元期にしたランも保存・復元できる。
  test('save ephemeris context: 数値暦の無い元期でも暦情報を組めて復元できる', () => {
    const analyticOnly = ephemerisContextFor(createJulianDate('TDB', 2451545));
    assert.equal(analyticOnly.profileId, null);
    assert.equal(analyticOnly.packId, null);
    assert.equal(isEphemerisContextRestorable({ ...analyticOnly }), true);
  });

  // 暦情報を欠く・壊れているスナップショットには、補える基底値が無い(SAVE.md「形式の版」)。
  test('save ephemeris context: 欠けている・壊れている暦情報は復元できない', () => {
    assert.equal(isEphemerisContextRestorable(undefined), false);
    assert.equal(isEphemerisContextRestorable(null), false);
    assert.equal(isEphemerisContextRestorable({ ...CONTEXT, packId: '' }), false);
    assert.equal(isEphemerisContextRestorable({ epochJdTdb: CONTEXT.epochJdTdb }), false);
  });
}
