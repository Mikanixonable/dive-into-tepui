// halo.ts の回帰テスト: 返る状態が有限であること、面外振幅 0 のリサジューが軌道面内に
// 収まること、生成した点が指定振幅のオーダーでラグランジュ点近傍にあること。
// ハロー/リサジューは制限三体問題の線形近似解であり理論的な厳密値がないため、
// 「有限」「面内」「振幅のオーダー」という緩い性質のみを確認する。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { CenterManifoldParams, LibrationPoint, LibrationSystem, collinearFrame, haloState, lissajousState } from '../../src/physics/halo';
import { Ephemeris } from '../../src/physics/ephemeris';
import { dot, len, sub } from '../../src/physics/vec3';

const SYSTEMS: LibrationSystem[] = ['earthMoon', 'sunEarth'];
const POINTS: LibrationPoint[] = ['L1', 'L2'];

function isFiniteVec(v: { x: number; y: number; z: number }): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

export function register(): void {
  const ephemeris = new Ephemeris(0, 0.7);
  const t = 1e6;

  for (const system of SYSTEMS) {
    for (const point of POINTS) {
      const label = `${system}/${point}`;
      const ax = 1e4;
      const az = 5e3;
      const params: CenterManifoldParams = { system, point, ax, az, phase: 0.3, psi: 1.1 };

      test(`halo: ${label} lissajousState is finite`, () => {
        const s = lissajousState(t, ephemeris, params);
        assert.ok(isFiniteVec(s.r), `r not finite: ${JSON.stringify(s.r)}`);
        assert.ok(isFiniteVec(s.v), `v not finite: ${JSON.stringify(s.v)}`);
        assert.equal(s.t, t);
      });

      test(`halo: ${label} haloState is finite`, () => {
        const s = haloState(t, ephemeris, params);
        assert.ok(isFiniteVec(s.r), `r not finite: ${JSON.stringify(s.r)}`);
        assert.ok(isFiniteVec(s.v), `v not finite: ${JSON.stringify(s.v)}`);
      });

      test(`halo: ${label} lissajous with az=0 stays in the L-point orbital plane`, () => {
        const frame = collinearFrame(system, point, t, ephemeris);
        const s = lissajousState(t, ephemeris, { ...params, az: 0 });
        const rel = sub(s.r, frame.origin);
        const outOfPlane = Math.abs(dot(rel, frame.zHat));
        assert.ok(outOfPlane < 1e-3, `expected ~0 out-of-plane offset, got ${outOfPlane} m`);
      });

      test(`halo: ${label} generated point stays within amplitude order of the L-point`, () => {
        const frame = collinearFrame(system, point, t, ephemeris);
        const s = haloState(t, ephemeris, params);
        const dist = len(sub(s.r, frame.origin));
        const bound = 20 * (ax + az); // |kappa| は 1 のオーダーなので十分緩い上限
        assert.ok(dist < bound, `${label}: distance from L-point ${dist} exceeds bound ${bound}`);
      });

      test(`halo: ${label} linear frequencies are finite and positive`, () => {
        const frame = collinearFrame(system, point, t, ephemeris);
        assert.ok(Number.isFinite(frame.lambda) && frame.lambda > 0, `lambda: ${frame.lambda}`);
        assert.ok(Number.isFinite(frame.omegaZ) && frame.omegaZ > 0, `omegaZ: ${frame.omegaZ}`);
        assert.ok(Number.isFinite(frame.kappa), `kappa: ${frame.kappa}`);
      });
    }
  }
}
