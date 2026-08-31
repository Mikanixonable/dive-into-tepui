import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  PackFormatError,
  buildPackData,
  canonicalJson,
  decodePack,
  encodePack,
  toChebyshevPack,
  validateManifest,
} from '../../src/physics/ephemeris/pack-format';

const BASE = {
  format: 'tepui-ephemeris-pack' as const,
  version: 1 as const,
  frame: 'ICRF-J2000' as const,
  timeScale: 'TDB',
  timeOrigin: 'J2000-ET' as const,
  positionUnit: 'm' as const,
  timeUnit: 's' as const,
  validStart: 0,
  validEnd: 100,
};

const SEGMENTS = [
  {
    body: 'fixture',
    start: 0,
    end: 50,
    coefficients: [[1, 2], [3, 4], [5, 6]] as const,
  },
  {
    body: 'fixture',
    start: 50,
    end: 100,
    coefficients: [[7, 8], [9, 10], [11, 12]] as const,
  },
] as const;

function throwsFormat(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => error instanceof PackFormatError);
}

export function register(): void {
  test('ephemeris pack: deterministic Float64 Chebyshev roundtrip', () => {
    const data = buildPackData(BASE, SEGMENTS);
    const bytes = encodePack(data.manifest, data.payload);
    const decoded = decodePack(bytes);
    assert.deepEqual(decoded.manifest, data.manifest);
    assert.deepEqual(Array.from(decoded.payload), Array.from(data.payload));
    assert.equal(decoded.manifestJson, canonicalJson(data.manifest));
    assert.deepEqual(bytes, encodePack({ ...data.manifest }, data.payload));
  });

  test('ephemeris pack: truncated, bad-header, and non-finite payload corruption is rejected', () => {
    const data = buildPackData(BASE, SEGMENTS);
    const bytes = encodePack(data.manifest, data.payload);

    throwsFormat(() => decodePack(bytes.subarray(0, bytes.length - 1)));
    const badMagic = bytes.slice();
    badMagic[0] ^= 0xff;
    throwsFormat(() => decodePack(badMagic));
    const badLength = bytes.slice();
    badLength[20] += 8;
    throwsFormat(() => decodePack(badLength));
    const nonFinite = bytes.slice();
    new DataView(nonFinite.buffer).setFloat64(nonFinite.length - 8, Number.NaN, true);
    throwsFormat(() => decodePack(nonFinite));
    const infinite = bytes.slice();
    new DataView(infinite.buffer).setFloat64(infinite.length - 8, Number.POSITIVE_INFINITY, true);
    throwsFormat(() => decodePack(infinite));
  });

  test('ephemeris pack: decoding is unaffected by the input view offset', () => {
    const data = buildPackData(BASE, SEGMENTS);
    const bytes = encodePack(data.manifest, data.payload);

    // 任意のバイト境界に置いた view でも Float64 の値が壊れないこと。
    for (const offset of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const shifted = new Uint8Array(offset + bytes.length);
      shifted.set(bytes, offset);
      const decoded = decodePack(shifted.subarray(offset));
      assert.deepEqual(Array.from(decoded.payload), Array.from(data.payload));
      assert.deepEqual(Array.from(decoded.payloadBytes), Array.from(bytes.subarray(bytes.length - decoded.payloadBytes.length)));
    }
  });

  test('ephemeris pack: manifest version and validity ranges are checked', () => {
    const data = buildPackData(BASE, SEGMENTS);
    assert.equal(data.manifest.series[0]?.coefficientCount, 6);

    throwsFormat(() => validateManifest({ ...data.manifest, version: 2 }));
    throwsFormat(() => validateManifest({ ...data.manifest, validStart: 100, validEnd: 100 }));
    throwsFormat(() => validateManifest({
      ...data.manifest,
      series: [{ ...data.manifest.series[0], start: -1 }],
    }));
    throwsFormat(() => validateManifest({
      ...data.manifest,
      series: [{ ...data.manifest.series[0], coefficientOffset: 1 }],
    }));
    throwsFormat(() => validateManifest({ ...data.manifest, frame: 'ECI' }));
    throwsFormat(() => validateManifest({ ...data.manifest, timeScale: 'TT' }));
    throwsFormat(() => validateManifest({ ...data.manifest, timeOrigin: 'JD_TDB' }));
  });

  test('ephemeris pack: decoded data adapts to the existing evaluator pack shape', () => {
    const data = buildPackData(BASE, SEGMENTS);
    const evaluatorPack = toChebyshevPack({
      manifest: data.manifest,
      payload: data.payload,
      payloadBytes: new Uint8Array(),
      manifestJson: canonicalJson(data.manifest),
    });
    assert.deepEqual(evaluatorPack.manifest.bodies.map((body) => body.id), ['fixture']);
    // 座標系と時刻系はワイヤ manifest が宣言し decodePack が検証する。
    // 評価器側の manifest で言い直さない。
    assert.equal(data.manifest.frame, 'ICRF-J2000');
    assert.equal(data.manifest.timeScale, 'TDB');
    assert.equal(evaluatorPack.manifest.bodies[0]?.segments[0]?.start, 0);
    // 係数は payload へのビュー(Float64Array)で返る — 複製しないため。
    assert.deepEqual(
      Array.from(evaluatorPack.bodies[0]!.segments[1]!.coefficients[2] as Float64Array), [11, 12]);
  });
}
