// 被覆率を不透明な形と半透明な雲へ分ける規則の検査。同じ式が GPU 側(CloudShapeEvaluator)で
// 使われるので、ここでは分割の不変条件を確かめる — 形が現れない極限では被覆率がそのまま
// 半透明へ流れ、現れる中間域では不透明と半透明の和が被覆率を再構成する。
import * as assert from 'node:assert/strict';
import {
  CLOSED_THRESHOLD, OPAQUE_COVERAGE_CENTER, OPAQUE_OPTICAL_DEPTH_FULL, OPAQUE_OPTICAL_DEPTH_ONSET,
  expectedOpaqueFraction, opaqueThreshold, translucentResidual,
} from '../../src/render/cloud/coverage-split';
import { test } from '../harness';

export function register(): void {
  test('coverage split: 解像できない柱では形は現れず、被覆率はすべて半透明へ流れる', () => {
    for (const coverage of [0, 0.2, 0.5, 0.9, 1]) {
      // 細部の標準偏差の下限があるので厳密には 0 ではないが、小さい側へ張り付いたロジスティック
      // の値(1e-100 台)なので見えない。
      assert.ok(expectedOpaqueFraction(coverage, 0, 100) < 1e-100);
      assert.equal(translucentResidual(coverage, 0), coverage);
    }
  });

  test('coverage split: 光学的に薄い柱では形はほぼ現れず、厚い柱では被覆率の中央値を境に現れる', () => {
    // しきい値が閉じる(1.2)と被覆率 1 の柱にも細部の裾で数%の形が残る — 縁の連続性のための
    // 滑らかさで、点として見えない程度の量に留まる。
    assert.ok(expectedOpaqueFraction(1, 1, OPAQUE_OPTICAL_DEPTH_ONSET) < 0.1);
    assert.ok(expectedOpaqueFraction(0.5, 1, OPAQUE_OPTICAL_DEPTH_ONSET) < 1e-3);
    assert.ok(expectedOpaqueFraction(0.8, 1, OPAQUE_OPTICAL_DEPTH_FULL) > 0.9);
  });

  test('coverage split: 不透明のしきい値は中央値と閉じた値のあいだに収まる', () => {
    assert.equal(opaqueThreshold(0, 100), CLOSED_THRESHOLD);
    assert.equal(opaqueThreshold(0, 0), CLOSED_THRESHOLD);
    assert.equal(opaqueThreshold(1, OPAQUE_OPTICAL_DEPTH_FULL), OPAQUE_COVERAGE_CENTER);
    for (const resolvability of [0.1, 0.5, 0.9]) {
      for (const opticalDepth of [0.5, 2, 10]) {
        const threshold = opaqueThreshold(resolvability, opticalDepth);
        assert.ok(threshold >= OPAQUE_COVERAGE_CENTER && threshold <= CLOSED_THRESHOLD);
      }
    }
  });

  test('coverage split: 不透明な形と半透明の雲の和は被覆率を再構成する', () => {
    // residual が 0 へ張り付く(形の期待値が被覆率を越える)とき、平均は形の面積そのものになる。
    // その場合も、平均が被覆率を数%以上下回ることは無い。
    for (const coverage of [0.05, 0.2, 0.34, 0.5, 0.7, 0.9, 1]) {
      for (const resolvability of [0, 0.25, 0.5, 1]) {
        for (const opticalDepth of [0, 1, 3, 8, 150]) {
          const opaque = expectedOpaqueFraction(coverage, resolvability, opticalDepth);
          const residual = translucentResidual(coverage, opaque);
          assert.ok(opaque >= 0 && opaque <= 1, `opaque=${opaque} @(${coverage},${resolvability},${opticalDepth})`);
          assert.ok(residual >= 0 && residual <= 1, `residual=${residual} @(${coverage},${resolvability},${opticalDepth})`);
          const mean = opaque + (1 - opaque) * residual;
          assert.ok(mean >= coverage - 0.05, `mean=${mean} coverage=${coverage} @(${resolvability},${opticalDepth})`);
          if (residual > 0 && opaque < 0.99) {
            assert.ok(
              Math.abs(mean - coverage) < 1e-6,
              `mean=${mean} coverage=${coverage} @(${resolvability},${opticalDepth})`,
            );
          }
        }
      }
    }
  });

  test('coverage split: 不透明な形の面積は被覆率に単調で、端で跳ばない', () => {
    let previous = expectedOpaqueFraction(0, 1, 20);
    for (let i = 1; i <= 400; i++) {
      const coverage = i / 400;
      const opaque = expectedOpaqueFraction(coverage, 1, 20);
      assert.ok(opaque >= previous, `not monotone at coverage=${coverage}`);
      assert.ok(opaque - previous < 0.05, `jump at coverage=${coverage}`);
      previous = opaque;
    }
  });

  test('coverage split: 解像度が 0 と 1 のあいだで形の面積は連続に増える', () => {
    let previous = expectedOpaqueFraction(0.6, 0, 10);
    for (let i = 1; i <= 400; i++) {
      const resolvability = i / 400;
      const opaque = expectedOpaqueFraction(0.6, resolvability, 10);
      assert.ok(opaque - previous < 0.05, `jump at resolvability=${resolvability}`);
      previous = opaque;
    }
    // 解像度を上げた分だけ形が受け持つ。
    assert.ok(previous > expectedOpaqueFraction(0.6, 0, 10));
  });
}
