// cr3bp.ts の数値修正法(differential correction)の回帰テスト。解析解(Richardson 3次)と
// 違い理論値がないので、「修正後の軌道が実際に周期的か」(半周期後に対称条件 vx=vz=0 を満たし、
// さらに全周期積分すると初期状態へ戻るか)を halo.ts の公開経路(correctedHaloOrbit)ごしに
// 直接検証する。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { propagateHaloState, sampleHaloOrbitPositions } from '../../src/physics/cr3bp';
import { collinearFrame, correctedHaloOrbit } from '../../src/physics/halo';
import { Ephemeris, EPOCH_T_OFFSET } from '../../src/physics/ephemeris';
import { SOLAR_SYSTEM } from '../../src/physics/solar-system';

export function register(): void {
  const ephemeris = new Ephemeris(SOLAR_SYSTEM, 'earth', EPOCH_T_OFFSET, { moon: 0.7 });
  const t = 1e6;
  const frame = collinearFrame('moon', 'L2', t, ephemeris);
  const mu = frame.mu;

  test('cr3bp: a moderate-amplitude Earth-Moon L2 halo converges and closes to a full period', () => {
    const halo = correctedHaloOrbit(frame, 'L2', 8000e3);
    assert.ok(halo !== null, 'differential correction did not converge');
    const { orbit } = halo!;

    const half = propagateHaloState(mu, orbit, Math.PI);
    assert.ok(Math.abs(half[3] as number) < 1e-8, `vx at half period: ${half[3]}`);
    assert.ok(Math.abs(half[5] as number) < 1e-8, `vz at half period: ${half[5]}`);

    const full = propagateHaloState(mu, orbit, 2 * Math.PI);
    assert.ok(Math.abs((full[0] as number) - orbit.x0) < 1e-6, `x drift over full period: ${full[0]! - orbit.x0}`);
    assert.ok(Math.abs(full[1] as number) < 1e-6, `y drift over full period: ${full[1]}`);
    assert.ok(Math.abs((full[2] as number) - orbit.z0) < 1e-6, `z drift over full period: ${full[2]! - orbit.z0}`);
  });

  test('cr3bp: continuation reaches an NRHO-scale amplitude beyond the Richardson series\' valid range', () => {
    // Earth-Moon L2 の実際の NRHO(Gateway 想定の 9:2 共鳴軌道相当)は Az が 6~7万 km 級 —
    // Richardson 3次解析解が発散する領域だが、継続法(平面軌道からの数値修正)は追跡できる。
    const targetAz = 65000e3;
    const halo = correctedHaloOrbit(frame, 'L2', targetAz);
    assert.ok(halo !== null, 'continuation to NRHO amplitude did not converge');
    const { orbit } = halo!;

    const half = propagateHaloState(mu, orbit, Math.PI);
    assert.ok(Math.abs(half[3] as number) < 1e-6, `vx at half period: ${half[3]}`);
    assert.ok(Math.abs(half[5] as number) < 1e-6, `vz at half period: ${half[5]}`);

    const full = propagateHaloState(mu, orbit, 2 * Math.PI);
    const drift = Math.hypot((full[0] as number) - orbit.x0, full[1] as number, (full[2] as number) - orbit.z0);
    assert.ok(drift < 1e-5, `full-period drift: ${drift}`);

    // NRHO らしさ: 近月点が月に近い(垂直リアプノフ分岐に向かって離心が進む特徴)。
    const positions = sampleHaloOrbitPositions(mu, orbit, 64);
    const minDistToSecondary = Math.min(...positions.map((p) => Math.hypot(p.x - (1 - mu), p.y, p.z)));
    assert.ok(minDistToSecondary * frame.r < 60000e3, `perilune distance: ${minDistToSecondary * frame.r / 1e3} km`);
  });
}
