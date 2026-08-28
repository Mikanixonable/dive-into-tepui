import * as assert from 'node:assert/strict';
import { SweptSphereContact, sweptSphereContact } from '../../src/physics/sphere-contact';
import { KinematicState, kinematicState } from '../../src/physics/kinematic-state';
import { Vec3, scale, sub, v3 } from '../../src/math/vec3';
import { test } from './harness';

// 曲線ソルバーは細分と二分で跨ぎ時刻を詰めるので、閉形式のような厳密値にはならない。実測で 1e-8 級。
const TOI_TOLERANCE = 1e-7;

// 区間 [0, 1] を等速で渡る2球の掃引。位置だけを与え、速度は変位から取る — 等速なので
// 曲線は弦に一致し、線分で解いたときと同じ答えになる。
function swept(
  a0: Vec3, a1: Vec3, b0: Vec3, b1: Vec3, radiusSum: number,
): SweptSphereContact | null {
  const av = sub(a1, a0), bv = sub(b1, b0);
  return sweptSphereContact(
    kinematicState(0, a0, av), kinematicState(1, a1, av),
    kinematicState(0, b0, bv), kinematicState(1, b1, bv),
    radiusSum);
}

// 相手球が区間を等速で渡るとみなした掃引。a 側は端点の速度をそのまま接線に取るので、
// 弦とは違う曲線になる。
function sweptCurved(
  prev: KinematicState, next: KinematicState, b0: Vec3, b1: Vec3, radiusSum: number,
): SweptSphereContact | null {
  const bv = scale(sub(b1, b0), 1 / (next.t - prev.t));
  return sweptSphereContact(
    prev, next, kinematicState(prev.t, b0, bv), kinematicState(next.t, b1, bv), radiusSum);
}

export function register(): void {
  test('swept sphere: catches a complete pass-through in one frame', () => {
    const hit = swept(v3(), v3(), v3(-10, 0, 0), v3(10, 0, 0), 2)?.crossing;
    assert.ok(hit);
    assert.ok(Math.abs(hit.toi - 0.4) < TOI_TOLERANCE);
    assert.deepEqual(hit.normal, v3(-1, 0, 0));
  });

  test('swept sphere: catches the same crossing when frame interval is split', () => {
    assert.equal(swept(v3(), v3(), v3(-10, 0, 0), v3(-3, 0, 0), 2)?.crossing, null);
    const hit = swept(v3(), v3(), v3(-3, 0, 0), v3(4, 0, 0), 2)?.crossing;
    assert.ok(hit);
    assert.ok(Math.abs(hit.toi - 1 / 7) < TOI_TOLERANCE);
  });

  test('swept sphere: 表面に触れない近傍通過は跨ぎなし', () => {
    const miss = swept(v3(), v3(), v3(-10, 3, 0), v3(10, 3, 0), 2);
    assert.ok(miss);
    assert.equal(miss.startsInside, false);
    assert.equal(miss.crossing, null);
  });

  // 始点で既に重なっている区間では、跨ぎは内から外へ向かう。呼び出し側はその向きを
  // startsInside から読む。
  test('swept sphere: 始点が内側なら抜け出る瞬間を返す', () => {
    const out = swept(v3(), v3(), v3(0.5, 0, 0), v3(5, 0, 0), 2);
    assert.ok(out);
    assert.equal(out.startsInside, true);
    assert.ok(out.crossing);
    assert.ok(Math.abs(out.crossing!.toi - 1 / 3) < 1e-6, `脱出 TOI ${out.crossing!.toi}`);
    // 跨ぎの瞬間の相対距離は半径和に一致する。
    const distance = 0.5 + 4.5 * out.crossing!.toi;
    assert.ok(Math.abs(distance - 2) < 1e-5, `跨ぎ位置の距離 ${distance}`);
    assert.deepEqual(out.crossing!.normal, v3(1, 0, 0));
  });

  test('swept sphere: 両端とも内側なら跨ぎなしで内側から始まったと返す', () => {
    const stay = swept(v3(), v3(), v3(0.5, 0, 0), v3(1, 0, 0), 2);
    assert.ok(stay);
    assert.equal(stay.startsInside, true);
    assert.equal(stay.crossing, null);
  });

  test('Hermite swept sphere: detects a moving-body pass when both endpoints are outside', () => {
    const prev = kinematicState(0, v3(-10, 0, 0), v3(20, 0, 0));
    const next = kinematicState(1, v3(10, 0, 0), v3(20, 0, 0));
    const toi = sweptCurved(prev, next, v3(0, -10, 0), v3(0, 10, 0), 2)?.crossing?.toi;
    assert.ok(toi !== undefined);
    const expected = 0.5 - Math.sqrt(2) / 20;
    assert.ok(Math.abs(toi - expected) < 1e-6, `unexpected moving-body TOI: ${toi}`);
  });

  // 端点の速度を接線に取るので、弦をたどるより遅く抜ける。脱出の瞬間も曲線の上で解く。
  test('Hermite swept sphere: 始点で重なっている区間は曲線の上で脱出を解く', () => {
    const prev = kinematicState(0, v3(1, 0, 0), v3(1, 0, 0));
    const next = kinematicState(1, v3(3, 0, 0), v3(1, 0, 0));
    const contact = sweptCurved(prev, next, v3(), v3(), 2);
    assert.ok(contact);
    assert.equal(contact.startsInside, true);
    assert.ok(contact.crossing);
    assert.ok(Math.abs(contact.crossing!.toi - 0.5) < 1e-6, `脱出 TOI ${contact.crossing!.toi}`);
  });

  // 弦は天体から離れているのに Hermite 曲線が膨らんで天体を掠める配置。掃引前の棄却が
  // 弦の長さで近似されていると、この通過を取りこぼす。
  test('Hermite swept sphere: 弦は外れていても曲線が膨らんで届く通過を捕まえる', () => {
    const prev = kinematicState(0, v3(-1000, 900, 0), v3(3000, -5400, 0));
    const next = kinematicState(1, v3(1000, 900, 0), v3(3000, 5400, 0));
    assert.equal(swept(v3(), v3(), v3(-1000, 900, 0), v3(1000, 900, 0), 700)?.crossing, null);
    const toi = sweptCurved(prev, next, v3(), v3(), 700)?.crossing?.toi;
    assert.ok(toi !== undefined && toi > 0 && toi < 1, `unexpected bulge TOI: ${toi}`);
  });

  test('Hermite swept sphere: 制御点の箱ごと球から離れた天体は跨ぎなし', () => {
    const prev = kinematicState(0, v3(-10, 0, 0), v3(20, 0, 0));
    const next = kinematicState(1, v3(10, 0, 0), v3(20, 0, 0));
    assert.equal(sweptCurved(prev, next, v3(1e9, 0, 0), v3(1e9, 0, 0), 1000)?.crossing, null);
  });

  // 非有限な入力(始点・終点の位置・半径和)はどれも null へ落ちることを固定する —
  // resolveSphereCollision と同じ「参加者フィルタが破れても伝播しない」最後の砦。
  test('swept sphere: 始点が非有限なら null', () => {
    assert.equal(swept(v3(NaN, 0, 0), v3(0, 0, 0), v3(-10, 0, 0), v3(10, 0, 0), 2), null);
  });

  test('swept sphere: 終点が非有限なら null', () => {
    assert.equal(swept(v3(0, 0, 0), v3(NaN, 0, 0), v3(-10, 0, 0), v3(10, 0, 0), 2), null);
  });

  test('swept sphere: 半径和が非有限なら null', () => {
    assert.equal(swept(v3(0, 0, 0), v3(0, 0, 0), v3(-10, 0, 0), v3(10, 0, 0), NaN), null);
  });
}
