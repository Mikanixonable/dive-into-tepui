// NOAA GOES ABI の各製品が宣言する DQF 値と good-only mask を検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { classifyAbiQualityFlag, type AbiQualityProduct } from '../../tools/cloud-reference/abi-quality';

/** 観測 NetCDF の L1b/L2 品質 flag 定義を値ごとに検査する。 */
export function register(): void {
  test('ABI quality: L1b and categorical L2 products use their declared meanings', () => {
    const l1b = ['good', 'degraded', 'invalid', 'invalid', 'degraded'] as const;
    l1b.forEach((expected, value) => {
      assert.equal(classifyAbiQualityFlag(value, 'L1B_RAD').classification, expected);
    });

    const cth = ['good', 'degraded', 'invalid', 'invalid', 'unknown'] as const;
    cth.forEach((expected, value) => {
      assert.equal(classifyAbiQualityFlag(value, 'L2_ACHA').classification, expected);
    });
    assert.match(classifyAbiQualityFlag(4, 'L2_ACHA').meaning, /outside valid_range 0\.\.3/);

    const acm = ['good', 'invalid', 'invalid', 'unknown', 'unknown', 'unknown', 'degraded'] as const;
    acm.forEach((expected, value) => {
      assert.equal(classifyAbiQualityFlag(value, 'L2_ACM').classification, expected);
    });
  });

  test('ABI quality: COD day/night mode bit does not change retrieval quality', () => {
    const qualities = new Map<number, string>([
      [0, 'good'], [2, 'degraded'], [4, 'degraded'], [6, 'invalid'], [8, 'invalid'],
      [10, 'degraded'], [12, 'invalid'], [14, 'invalid'], [16, 'degraded'],
    ]);
    for (const [code, expected] of qualities) {
      for (const modeBit of [0, 1]) {
        if (code + modeBit > 16) continue;
        const result = classifyAbiQualityFlag(code + modeBit, 'L2_COD');
        assert.equal(result.classification, expected);
        assert.equal(result.mode, modeBit === 0 ? 'day' : 'night');
        assert.equal(result.goodOnly, expected === 'good');
      }
    }
    const nightNonconvergence = classifyAbiQualityFlag(17, 'L2_COD');
    assert.equal(nightNonconvergence.classification, 'degraded');
    assert.equal(nightNonconvergence.meaning, 'degraded_due_to_nonconvergence_qf');
    assert.equal(nightNonconvergence.mode, 'night');
    assert.equal(nightNonconvergence.goodOnly, false);
    assert.equal(classifyAbiQualityFlag(18, 'L2_COD').classification, 'unknown');
    assert.equal(classifyAbiQualityFlag(33, 'L2_COD').classification, 'unknown');
  });

  test('ABI quality: CTP overall bit classifies all observed six-bit combinations', () => {
    for (let value = 0; value <= 63; value += 1) {
      const result = classifyAbiQualityFlag(value, 'L2_ACTP');
      assert.equal(result.classification, (value & 1) === 0 ? 'good' : 'degraded');
      assert.equal(result.goodOnly, (value & 1) === 0);
    }
  });

  test('ABI quality: ACM spare, fill, and out-of-range values never pass good-only mask', () => {
    for (const value of [3, 4, 5, 255, 7, 254]) {
      const result = classifyAbiQualityFlag(value, 'L2_ACM');
      assert.equal(result.goodOnly, false);
      assert.notEqual(result.classification, 'good');
    }
  });

  test('ABI quality: invalid byte inputs and unsupported values never pass good-only mask', () => {
    const products: readonly AbiQualityProduct[] = ['L1B_RAD', 'L2_COD', 'L2_ACTP', 'L2_ACHA', 'L2_ACM'];
    for (const product of products) {
      for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 256]) {
        const result = classifyAbiQualityFlag(value, product);
        assert.equal(result.classification, 'unknown');
        assert.equal(result.goodOnly, false);
        assert.equal(result.valid, false);
      }
    }
    assert.equal(classifyAbiQualityFlag(5, 'L1B_RAD').classification, 'unknown');
    assert.equal(classifyAbiQualityFlag(64, 'L2_ACTP').classification, 'unknown');
    assert.equal(classifyAbiQualityFlag(7, 'L2_ACHA').classification, 'unknown');
  });
}
