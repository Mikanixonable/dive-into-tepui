import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  condenseGlobalColumn, condenseGlobalMassField,
} from '../../src/render/cloud/cloud-global-condensation';
import { CLOUD_TOP_SPAN } from '../../src/render/cloud/cumulus-shape';
import type { CloudGlobalMassField } from '../../src/render/cloud/global-mass-field';

// 手計算の基準値。液水は τ = 3·LWP/(2ρr) = 150·LWP [kg/m²]、氷は
// τ = 3·Q·IWP/(4ρr) ≈ 54.5·IWP [kg/m²](r_liq = 10 µm、r_ice = 30 µm、Q = 2)。
const TAU_PER_LIQUID_KG_M2 = 150;
const TAU_PER_ICE_KG_M2 = 3 * 2 / (4 * 917 * 30e-6);

export function register(): void {
  test('global condensation: 質量のない列は透明', () => {
    const sample = condenseGlobalColumn([0, 0], [0, 0], [0, 2_000, 8_000]);
    assert.equal(sample.coverage, 0);
    assert.equal(sample.translucent, 0);
    assert.equal(sample.cloudTopM, 0);
  });

  test('global condensation: 厚い液水はほぼ全面を覆い、雲頂はその層の上端', () => {
    // LWP 1 kg/m² → τ = 150。coverage = 1 − exp(−150/15) ≈ 0.99995。
    const sample = condenseGlobalColumn([1], [0], [0, 2_000]);
    const expected = 1 - Math.exp(-TAU_PER_LIQUID_KG_M2 / 15);
    assert.ok(sample.coverage > 0.99 && Math.abs(sample.coverage - expected) < 1e-3,
      `coverage ${sample.coverage}`);
    assert.equal(sample.cloudTopM, 2_000);
    assert.ok(sample.translucent < 0.01, `translucent ${sample.translucent}`);
  });

  test('global condensation: 薄い氷層は薄い雲の τ を出し、被覆はほぼ 0', () => {
    // IWP 0.001 kg/m² → τ ≈ 0.0545。薄い重み ≈ 0.947。
    const sample = condenseGlobalColumn([0, 0, 0], [0, 0, 0.001], [0, 2_000, 8_000, 15_000]);
    assert.ok(sample.coverage < 0.01, `coverage ${sample.coverage}`);
    const expectedTau = TAU_PER_ICE_KG_M2 * 0.001 * Math.exp(-TAU_PER_ICE_KG_M2 * 0.001);
    assert.ok(Math.abs(sample.translucent - expectedTau) < 0.005,
      `translucent ${sample.translucent} vs ${expectedTau}`);
    assert.equal(sample.cloudTopM, 15_000);
  });

  test('global condensation: 雲頂は τ が閾値を超える最上層の上端', () => {
    // 中層に厚い液水、最上層にわずかな氷(τ ≈ 0.55 > 0.05)。
    const sample = condenseGlobalColumn([1, 0, 0], [0, 0, 0.01], [0, 2_000, 8_000, 15_000]);
    assert.equal(sample.cloudTopM, 15_000);
  });

  test('global condensation: 閾値未満の τ は雲頂を立てないが薄い雲には残る', () => {
    // IWP 0.0005 kg/m² → τ ≈ 0.027 < 0.05。
    const sample = condenseGlobalColumn([0], [0.0005], [0, 15_000]);
    assert.equal(sample.cloudTopM, 0);
    assert.ok(sample.translucent > 0, `translucent ${sample.translucent}`);
  });

  test('global condensation: 同じ質量でも液水のほうが氷より強く消す', () => {
    // 0.01 kg/m²: 液水 τ = 1.5、氷 τ ≈ 0.55。薄い重みの差も含めて被覆が変わる。
    // 手計算: liquid opaque = 1.5·(1−e^−1.5) ≈ 1.165 → coverage ≈ 0.0747、
    // ice opaque = 0.545·(1−e^−0.545) ≈ 0.229 → coverage ≈ 0.0152。
    const liquid = condenseGlobalColumn([0.01], [0], [0, 4_000]);
    const ice = condenseGlobalColumn([0], [0.01], [0, 4_000]);
    assert.ok(Math.abs(liquid.coverage - 0.0747) < 0.002, `liquid ${liquid.coverage}`);
    assert.ok(Math.abs(ice.coverage - 0.0152) < 0.002, `ice ${ice.coverage}`);
    assert.ok(liquid.coverage > ice.coverage,
      `liquid ${liquid.coverage} vs ice ${ice.coverage}`);
  });

  test('global condensation: 質量を増やすと被覆は単調に増える', () => {
    let previous = -1;
    for (const massKgM2 of [0.001, 0.01, 0.05, 0.2, 1]) {
      const sample = condenseGlobalColumn([massKgM2], [0], [0, 4_000]);
      assert.ok(sample.coverage > previous, `coverage ${sample.coverage} after ${previous}`);
      previous = sample.coverage;
    }
  });

  test('global condensation: 場の凝結は RGBA 配置とセル配置を保つ', () => {
    // 4×2、層 [0,2000]。セル 3(行 0, 列 3)へ液水 1 kg/m²、それ以外は空。
    const liquidKgM2 = new Float64Array(8);
    liquidKgM2[3] = 1;
    const field: CloudGlobalMassField = {
      width: 4, height: 2, sphereRadiusM: 6_371_000,
      layerEdgesM: [0, 2_000],
      liquidKgM2,
      iceKgM2: new Float64Array(8),
    };
    const texels = condenseGlobalMassField(field);
    assert.equal(texels.length, 32);
    // 空のセルは完全に透明。
    assert.deepEqual([...texels.slice(0, 4)], [0, 0, 0, 1]);
    // 雲のあるセル: R=被覆率、G=雲頂/CLOUD_TOP_SPAN、B=薄い雲、A=1。
    const texel = texels.slice(12, 16);
    assert.ok(texel[0]! > 0.99, `coverage ${texel[0]}`);
    assert.ok(Math.abs(texel[1]! - 2_000 / CLOUD_TOP_SPAN) < 1e-6, `cloudTop ${texel[1]}`);
    assert.ok(texel[2]! < 0.01, `translucent ${texel[2]}`);
    assert.equal(texel[3], 1);
  });
}
