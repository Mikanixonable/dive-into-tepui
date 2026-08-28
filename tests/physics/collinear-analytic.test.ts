// 共線点まわりの解析解の回帰テスト。共線点 γ は文献値が期待値の正本になる。焼き込んだ
// 軌道カタログそのものは orbit-catalog.test.ts が受け持つ。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { collinearGamma } from '../../src/physics/lagrange';

export function register(): void {
  // 文献値との突き合わせ。質量比も文献の値を使う(レジストリの質量とは端数が異なる)。
  test('collinear: collinearGamma matches the published Earth-Moon values', () => {
    assert.ok(Math.abs(collinearGamma(0.0121505856, 'L1') - 0.150935) < 1e-4);
    assert.ok(Math.abs(collinearGamma(0.0121505856, 'L2') - 0.167833) < 1e-4);
  });

  test('collinear: collinearGamma matches the published Sun-Earth value', () => {
    assert.ok(Math.abs(collinearGamma(3.0404e-6, 'L1') - 0.0100109) < 1e-6);
  });

  // L3 の γ は主天体から測る距離比で、5次方程式の根であり、小さい mu では 1-(7/12)mu に漸近する。
  test('collinear: collinearGamma solves the L3 quintic', () => {
    for (const mu of [1e-7, 3.0404e-6, 1e-3, 0.0121505856, 0.1]) {
      const g = collinearGamma(mu, 'L3');
      const residual = g ** 5 + (2 + mu) * g ** 4 + (1 + 2 * mu) * g ** 3
        - (1 - mu) * g * g - 2 * (1 - mu) * g - (1 - mu);
      assert.ok(Math.abs(residual) < 1e-12, `mu=${mu}: residual ${residual}`);
      assert.ok(Math.abs(g - (1 - (7 / 12) * mu)) < 20 * mu * mu, `mu=${mu}: gamma ${g}`);
    }
  });
}
