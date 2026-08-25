// 共線点まわりの解析解の回帰テスト。共線点 γ は文献値が、Richardson 三次近似は
// 「数値解の良い初期推定であること」が期待値の正本になる。焼き込んだ軌道カタログそのものは
// orbit-catalog.test.ts が受け持つ。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { collinearGamma } from '../../src/physics/lagrange';
import { correctHaloOrbit } from '../../src/physics/cr3bp';
import {
  collinearParams, richardsonAmplitudeX, richardsonCoefficients, richardsonHaloSeed,
} from '../../src/physics/halo';
import { MU_EARTH, MU_MOON, MU_SUN } from '../../src/physics/solar-system';

type CollinearPointLabel = 'L1' | 'L2' | 'L3';

const SYSTEMS = ['sun-earth', 'earth-moon'] as const;
const POINTS: CollinearPointLabel[] = ['L1', 'L2', 'L3'];

// 文献と同じ質量比をレジストリの重力定数から組む。
const MU_OF: Record<(typeof SYSTEMS)[number], number> = {
  'sun-earth': MU_EARTH / (MU_SUN + MU_EARTH),
  'earth-moon': MU_MOON / (MU_EARTH + MU_MOON),
};

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

  // Richardson 三次近似は数値解の良い初期推定でなければならない。微分修正が受け取った
  // 種からどれだけ動くかで、近似の質を測る。
  // Richardson 三次近似は数値解の良い初期推定でなければならない。微分修正が受け取った種から
  // どれだけ動くかで、近似の質を測る。
  test('collinear: the third-order seed is close to the corrected halo orbit', () => {
    for (const system of SYSTEMS) {
      const mu = MU_OF[system];
      for (const point of POINTS) {
        const params = collinearParams(point, mu);
        const az = 0.05;
        const ax = richardsonAmplitudeX(richardsonCoefficients(params), az);
        const seeded = richardsonHaloSeed(params, az);
        assert.ok(seeded !== null, `${system}/${point}: 三次近似の種が組めない`);
        const { state: seed, period } = seeded;
        const corrected = correctHaloOrbit(mu, seed, 'z', period / 2);
        assert.ok(corrected !== null, `${system}/${point}: 三次近似の種から収束しない`);
        // L3 の γ は両天体間距離とほぼ等しく、L点まわりの局所展開という前提が成り立たない
        // ため、近さは L1/L2 でだけ要求する。
        if (point === 'L3') continue;
        const size = Math.hypot(ax, az) * params.gamma;
        const drift = Math.abs(corrected.state[0] - seed[0])
          + Math.abs(corrected.state[4] - seed[4]) / (2 * Math.PI / period);
        assert.ok(drift < 0.15 * size, `${system}/${point}: 種のずれ ${drift / size} が大きすぎる`);
        assert.ok(Math.abs(corrected.period - period) < 0.05 * period, `${system}/${point}: 周期のずれ`);
      }
    }
  });
}
