// halo.ts の回帰テスト。線形化パラメータ(λ・ωz・c2・γ)と三次の振幅拘束は文献値のある量なので
// 実測値ではなく理論値で固定する。状態そのものは線形解なので厳密解が無く、「有限」「面内」
// 「振幅のオーダー」という緩い性質のみを確認する。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import {
  HaloParams, LissajousParams, CollinearPoint,
  collinearFrame, haloAmplitudeX, haloState, lissajousState,
} from '../../src/physics/halo';
import { Ephemeris, EPOCH_T_OFFSET } from '../../src/physics/ephemeris';
import { SOLAR_SYSTEM } from '../../src/physics/solar-system';
import { OrbitingId } from '../../src/physics/attractor';
import { dot, len, sub } from '../../src/physics/vec3';

const SECONDARIES: OrbitingId[] = ['moon', 'earth'];
const POINTS: CollinearPoint[] = ['L1', 'L2'];

function isFiniteVec(v: { x: number; y: number; z: number }): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

export function register(): void {
  const ephemeris = new Ephemeris(SOLAR_SYSTEM, 'earth', EPOCH_T_OFFSET, { moon: 0.7 });
  const t = 1e6;

  for (const secondary of SECONDARIES) {
    for (const point of POINTS) {
      const label = `${secondary}/${point}`;
      const ax = 1e4;
      const az = 5e3;
      const lissajous: LissajousParams = { secondary, point, ax, az, phase: 0.3, psi: 1.1 };
      const halo: HaloParams = { secondary, point, az: 1e7, phase: 0.3 };

      test(`halo: ${label} lissajousState is finite`, () => {
        const s = lissajousState(t, ephemeris, lissajous);
        assert.ok(isFiniteVec(s.r), `r not finite: ${JSON.stringify(s.r)}`);
        assert.ok(isFiniteVec(s.v), `v not finite: ${JSON.stringify(s.v)}`);
        assert.equal(s.t, t);
      });

      test(`halo: ${label} lissajous with az=0 stays in the L-point orbital plane`, () => {
        const frame = collinearFrame(secondary, point, t, ephemeris);
        const s = lissajousState(t, ephemeris, { ...lissajous, az: 0 });
        const rel = sub(s.r, frame.origin);
        const outOfPlane = Math.abs(dot(rel, frame.zHat));
        // moon 系(地球-月)は月の太陽摂動の周期項(黄緯補正)ぶん frame.zHat(平均軌道法線)と
        // 瞬時の月の軌道面がわずかに食い違うため、earth 系(太陽-地球)より緩めた許容を使う
        // (L点スケール ~1e7 m に対し相対 1e-6 未満)。
        const tol = secondary === 'moon' ? 30 : 1e-1;
        assert.ok(outOfPlane < tol, `expected ~0 out-of-plane offset, got ${outOfPlane} m`);
      });

      test(`halo: ${label} haloState is finite and near the L-point`, () => {
        const s = haloState(t, ephemeris, halo);
        assert.ok(s !== null, `${label}: no halo solution for az=${halo.az} m`);
        assert.ok(isFiniteVec(s!.r), `r not finite: ${JSON.stringify(s!.r)}`);
        assert.ok(isFiniteVec(s!.v), `v not finite: ${JSON.stringify(s!.v)}`);
        const frame = collinearFrame(secondary, point, t, ephemeris);
        const ampX = haloAmplitudeX(frame, point, halo.az)!;
        const dist = len(sub(s!.r, frame.origin));
        // |kappa| は数のオーダーなので、面内・面外振幅の和の数倍を上限とする。
        assert.ok(dist < 20 * (ampX + halo.az), `${label}: distance from L-point ${dist} too large`);
      });

      test(`halo: ${label} linear frequencies are finite and positive`, () => {
        const frame = collinearFrame(secondary, point, t, ephemeris);
        assert.ok(Number.isFinite(frame.lambda) && frame.lambda > 0, `lambda: ${frame.lambda}`);
        assert.ok(Number.isFinite(frame.omegaZ) && frame.omegaZ > 0, `omegaZ: ${frame.omegaZ}`);
        assert.ok(Number.isFinite(frame.kappa), `kappa: ${frame.kappa}`);
      });
    }
  }

  // 文献値との突き合わせ。Sun-Earth L1 の線形化パラメータは γ≈0.01、c2≈4.0611、
  // λ≈2.0864、ωz≈2.0152、|κ|≈3.2293。
  test('halo: Sun-Earth L1 linear parameters match the published values', () => {
    const frame = collinearFrame('earth', 'L1', t, ephemeris);
    assert.ok(Math.abs(frame.gamma - 0.01) < 5e-4, `gamma: ${frame.gamma}`);
    assert.ok(Math.abs(frame.lambda - 2.0864) < 2e-3, `lambda: ${frame.lambda}`);
    assert.ok(Math.abs(frame.omegaZ - 2.0152) < 2e-3, `omegaZ: ${frame.omegaZ}`);
    assert.ok(Math.abs(Math.abs(frame.kappa) - 3.2293) < 5e-3, `kappa: ${frame.kappa}`);
  });

  // Earth-Moon L1: γ≈0.1509、λ≈2.3344、ωz≈2.2688。
  test('halo: Earth-Moon L1 linear parameters match the published values', () => {
    const frame = collinearFrame('moon', 'L1', t, ephemeris);
    assert.ok(Math.abs(frame.gamma - 0.1509) < 2e-3, `gamma: ${frame.gamma}`);
    assert.ok(Math.abs(frame.lambda - 2.3344) < 5e-3, `lambda: ${frame.lambda}`);
    assert.ok(Math.abs(frame.omegaZ - 2.2688) < 5e-3, `omegaZ: ${frame.omegaZ}`);
  });

  // Richardson (1980) が例に挙げた Sun-Earth L1 のハロー(ISEE-3 相当): Az=110,000 km で
  // Ax≈206,000 km、Ay=|κ|·Ax≈666,000 km。三次の振幅拘束が正しく解けているかを見る。
  test('halo: Sun-Earth L1 amplitude constraint reproduces the ISEE-3 halo', () => {
    const frame = collinearFrame('earth', 'L1', t, ephemeris);
    const ax = haloAmplitudeX(frame, 'L1', 110000e3);
    assert.ok(ax !== null, 'no halo solution for Az = 110,000 km');
    assert.ok(Math.abs(ax! - 206000e3) < 6000e3, `Ax: ${ax! / 1e3} km`);
    const ay = Math.abs(frame.kappa) * ax!;
    assert.ok(Math.abs(ay - 666000e3) < 20000e3, `Ay: ${ay / 1e3} km`);
  });

  // 拘束 l1·Ax²+l2·Az²+Δ=0 は Az→0 で面内振幅の下限(平面リアプノフ軌道からハローが
  // 分岐する振幅)を与える。太陽-地球 L1 では約 20 万 km で、Az を増やすと単調に増える。
  test('halo: in-plane amplitude has a lower bound and grows with the out-of-plane one', () => {
    const frame = collinearFrame('earth', 'L1', t, ephemeris);
    const axMin = haloAmplitudeX(frame, 'L1', 0)!;
    assert.ok(Math.abs(axMin - 200000e3) < 20000e3, `Ax at Az=0: ${axMin / 1e3} km`);
    assert.ok(haloAmplitudeX(frame, 'L1', 110000e3)! > axMin, 'Ax should grow with Az');
  });
}
