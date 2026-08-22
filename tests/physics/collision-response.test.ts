import * as assert from 'node:assert/strict';
import {
  FixedContactResponse, Sphere,
  distributeFixedContact, resolveSphereCollision, sphereContactGeometry,
} from '../../src/physics/collision-response';
import { dot, len, lenSq, sub, v3, Vec3 } from '../../src/physics/vec3';
import { KinematicState, kinematicState } from '../../src/physics/kinematic-state';
import { test } from './harness';

// 天体との接触を、幾何を出す段と当てる段を繋いで解く — 表面接触の解決器が同じ順で呼ぶ。
function fixedContact(
  moving: Sphere, fixed: Sphere, restitution: number,
  prevMoving?: KinematicState, prevFixed?: KinematicState,
): FixedContactResponse | null {
  const geometry = sphereContactGeometry(moving, fixed, prevMoving, prevFixed);
  return geometry === null ? null : distributeFixedContact(moving, fixed, restitution, geometry);
}

// 渡されたベクトルの全成分が有限であること。質量の両極(0 と無限大)で NaN/Infinity が
// 位置・速度へ漏れないことを見るために使う。
function assertFinite(...vectors: readonly Vec3[]): void {
  for (const [i, u] of vectors.entries()) {
    assert.ok(Number.isFinite(u.x) && Number.isFinite(u.y) && Number.isFinite(u.z),
      `${i} 番目のベクトルに非有限値: ${JSON.stringify(u)}`);
  }
}

function overlapPair(vA: Vec3, vB: Vec3, invMassA: number, invMassB: number, restitution: number) {
  return resolveSphereCollision(
    { state: kinematicState(0, v3(-0.6, 0, 0), vA), radius: 1, invMass: invMassA },
    { state: kinematicState(0, v3(0.6, 0, 0), vB), radius: 1, invMass: invMassB },
    restitution,
  );
}

export function register(): void {
  test('collision-response: 運動量保存', () => {
    const massA = 2, massB = 5;
    const vA = v3(3, -1, 0), vB = v3(-2, 0.5, 0);
    const res = overlapPair(vA, vB, 1 / massA, 1 / massB, 0.4)!;
    const before = v3(massA * vA.x + massB * vB.x, massA * vA.y + massB * vB.y, massA * vA.z + massB * vB.z);
    const after = v3(
      massA * res.vA.x + massB * res.vB.x,
      massA * res.vA.y + massB * res.vB.y,
      massA * res.vA.z + massB * res.vB.z,
    );
    assert.ok(lenSq(sub(after, before)) < 1e-9);
  });

  test('collision-response: e=1 で運動エネルギー保存、e<1 で単調に損失する', () => {
    const massA = 3, massB = 1;
    const vA = v3(2, 0, 0), vB = v3(-4, 0, 0);
    const ke = (a: Vec3, b: Vec3) => 0.5 * massA * lenSq(a) + 0.5 * massB * lenSq(b);
    const keBefore = ke(vA, vB);

    const elastic = overlapPair(vA, vB, 1 / massA, 1 / massB, 1)!;
    assert.ok(Math.abs(ke(elastic.vA, elastic.vB) - keBefore) < 1e-9);

    let prevKe = keBefore;
    for (const e of [0.8, 0.5, 0.2, 0]) {
      const res = overlapPair(vA, vB, 1 / massA, 1 / massB, e)!;
      const keAfter = ke(res.vA, res.vB);
      assert.ok(keAfter < prevKe, `e=${e} でエネルギーが単調に減っていない`);
      prevKe = keAfter;
    }
  });

  test('collision-response: 逆質量0の相手は動かず、こちらの法線速度が-e倍になる', () => {
    const vA = v3(5, 0, 0); // 天体(不動)へ正面から接近
    const vB = v3(0, 0, 0);
    const res = overlapPair(vA, vB, 1 / 10, 0, 0.5)!;
    assert.deepEqual(res.rB, v3(0.6, 0, 0));
    assert.deepEqual(res.vB, vB);
    const vnBefore = dot(sub(vB, vA), res.normal);
    const vnAfter = dot(sub(res.vB, res.vA), res.normal);
    assert.ok(Math.abs(vnAfter - (-0.5 * vnBefore)) < 1e-9);
  });

  test('collision-response: 交換される運動量は換算質量に比例する', () => {
    const vA = v3(4, 0, 0), vB = v3(-4, 0, 0);
    const light = overlapPair(vA, vB, 1, 1, 0.6)!; // mass 1, 1 → 換算質量 0.5
    const heavy = overlapPair(vA, vB, 0.1, 0.1, 0.6)!; // mass 10, 10 → 換算質量 5(10倍)
    const momentum = (res: { vA: Vec3 }, mass: number) => Math.abs(res.vA.x - vA.x) * mass;
    assert.ok(Math.abs(momentum(heavy, 10) - momentum(light, 1) * 10) < 1e-6);
  });

  test('collision-response: Δv は質量に反比例する', () => {
    const massA = 2, massB = 8;
    const vA = v3(3, 0, 0), vB = v3(-3, 0, 0);
    const res = overlapPair(vA, vB, 1 / massA, 1 / massB, 0.5)!;
    const dvA = Math.abs(res.vA.x - vA.x);
    const dvB = Math.abs(res.vB.x - vB.x);
    assert.ok(Math.abs(dvA * massA - dvB * massB) < 1e-9);
    assert.ok(dvA > dvB); // 軽いA側のΔvの方が大きい
  });

  // 片側が非有限(位置/速度/半径/逆質量)のとき、resolveSphereCollision が相手側の値を
  // 一切書き換えないことを固定する — 参加者フィルタが破れても、この関数自身が伝播を
  // 止める最後の砦であること。位置・半径・逆質量は距離/換算質量そのものを壊すので
  // null(=両側とも変更なし)を返す。速度だけが例外で、位置補正には速度を使わないため
  // 反発の要否判定(vn)だけが壊れて非nullのまま返る — その場合も相手側(vB)は無傷。
  test('collision-response: 片側が非有限な位置なら null', () => {
    const res = resolveSphereCollision(
      { state: kinematicState(0, v3(NaN, 0, 0), v3(1, 0, 0)), radius: 1, invMass: 1 },
      { state: kinematicState(0, v3(0.6, 0, 0), v3(-1, 0, 0)), radius: 1, invMass: 1 },
      0.5,
    );
    assert.equal(res, null);
  });

  test('collision-response: 片側が非有限な速度は相手側の速度を書き換えない', () => {
    const res = resolveSphereCollision(
      { state: kinematicState(0, v3(-0.6, 0, 0), v3(NaN, 0, 0)), radius: 1, invMass: 1 },
      { state: kinematicState(0, v3(0.6, 0, 0), v3(-1, 0, 0)), radius: 1, invMass: 1 },
      0.5,
    )!;
    assert.ok(res !== null);
    assert.deepEqual(res.vB, v3(-1, 0, 0));
  });

  test('collision-response: 片側が非有限な半径なら null', () => {
    const res = resolveSphereCollision(
      { state: kinematicState(0, v3(-0.6, 0, 0), v3(1, 0, 0)), radius: NaN, invMass: 1 },
      { state: kinematicState(0, v3(0.6, 0, 0), v3(-1, 0, 0)), radius: 1, invMass: 1 },
      0.5,
    );
    assert.equal(res, null);
  });

  test('collision-response: 片側が非有限な逆質量なら null', () => {
    const res = resolveSphereCollision(
      { state: kinematicState(0, v3(-0.6, 0, 0), v3(1, 0, 0)), radius: 1, invMass: NaN },
      { state: kinematicState(0, v3(0.6, 0, 0), v3(-1, 0, 0)), radius: 1, invMass: 1 },
      0.5,
    );
    assert.equal(res, null);
  });

  // 質量0(逆質量Infinity)は試験粒子 — 相手に力を及ぼさず、自分だけが跳ね返る。
  test('collision-response: 質量0は相手を動かさず、自分だけが跳ね返る', () => {
    const res = resolveSphereCollision(
      { state: kinematicState(0, v3(-0.6, 0, 0), v3(1, 0, 0)), radius: 1, invMass: Infinity },
      { state: kinematicState(0, v3(0.6, 0, 0), v3(-1, 0, 0)), radius: 1, invMass: 1 },
      0.5,
    )!;
    assert.ok(res !== null);
    assert.deepEqual(res.rB, v3(0.6, 0, 0));
    assert.deepEqual(res.vB, v3(-1, 0, 0));
    assertFinite(res.rA, res.vA);
    // 接近速度 2 が -e 倍になるので、自分の速度は 1 → 1 - 1.5·2 = -2。
    assert.ok(Math.abs(res.vA.x - -2) < 1e-12);
  });

  test('collision-response: 質量0どうしは折半して離れ、非有限値を出さない', () => {
    const res = overlapPair(v3(1, 0, 0), v3(-1, 0, 0), Infinity, Infinity, 0.5)!;
    assert.ok(res !== null);
    assertFinite(res.rA, res.vA, res.rB, res.vB);
    // 折半なので、両者の速度変化は大きさが等しく向きが逆になる。
    assert.ok(Math.abs((res.vA.x - 1) + (res.vB.x - -1)) < 1e-12);
  });

  test('collision-response: 質量0の球が天体へ接触しても非有限値を出さない', () => {
    const res = fixedContact(
      { state: kinematicState(0, v3(-0.6, 0, 0), v3(1, 0, 0)), radius: 1 },
      { state: kinematicState(0, v3(0.6, 0, 0), v3()), radius: 1 },
      0.5,
    )!;
    assert.ok(res !== null);
    assertFinite(res.r, res.v);
    assert.ok(res.bounced);
    // 天体は 100% 相手が受け持つので、法線速度は -e 倍になる。
    assert.ok(Math.abs(res.v.x - -0.5) < 1e-12);
  });

  test('collision-response: 天体との接触は中心間を半径和ちょうどへ揃える', () => {
    const res = fixedContact(
      { state: kinematicState(0, v3(-0.6, 0, 0), v3(1, 0, 0)), radius: 1 },
      { state: kinematicState(0, v3(0.6, 0, 0), v3()), radius: 1 },
      0.5,
      kinematicState(-1, v3(-4, 0, 0), v3(1, 0, 0)),
      kinematicState(-1, v3(0.6, 0, 0), v3()),
    )!;
    assert.ok(res !== null);
    assert.ok(Math.abs(len(sub(v3(0.6, 0, 0), res.r)) - 2) < 1e-9);
  });

  test('collision-response: 双方が不動なら解決しない', () => {
    assert.equal(overlapPair(v3(1, 0, 0), v3(-1, 0, 0), 0, 0, 0.5), null);
  });

  test('collision-response: 完全弾性では力学エネルギーを失わない', () => {
    const res = overlapPair(v3(3, 0, 0), v3(-2, 0, 0), 1 / 2, 1 / 5, 1)!;
    assert.ok(res.bounced);
    assert.equal(res.specificEnergyLossA, 0);
    assert.equal(res.specificEnergyLossB, 0);
  });

  test('collision-response: 反発係数を下げると失う力学エネルギーは単調に増える', () => {
    let prevA = -1;
    let prevB = -1;
    for (const e of [1, 0.8, 0.6, 0.4, 0.2, 0]) {
      const res = overlapPair(v3(3, 0, 0), v3(-2, 0, 0), 1 / 2, 1 / 5, e)!;
      assert.ok(res.specificEnergyLossA > prevA, `e=${e}: A が単調でない`);
      assert.ok(res.specificEnergyLossB > prevB, `e=${e}: B が単調でない`);
      prevA = res.specificEnergyLossA;
      prevB = res.specificEnergyLossB;
    }
  });

  test('collision-response: 両側の合計は系が実際に失う力学エネルギーに一致する', () => {
    // 反発で失われるのは ½·μ·(1−e²)·vn²(μ は換算質量)。比量で受け取る両側を質量で戻した
    // 合計がこれと一致していなければ、熱がどこかで湧いているか消えている。
    const massA = 2, massB = 5;
    const restitution = 0.4;
    const vA = v3(3, -1, 0), vB = v3(-2, 0.5, 0);
    const res = overlapPair(vA, vB, 1 / massA, 1 / massB, restitution)!;
    const vn = dot(sub(vB, vA), res.normal);
    const reduced = 1 / (1 / massA + 1 / massB);
    const expected = 0.5 * reduced * (1 - restitution * restitution) * vn * vn;
    const total = massA * res.specificEnergyLossA + massB * res.specificEnergyLossB;
    assert.ok(Math.abs(total - expected) < 1e-12, `合計 ${total} に対し理論値 ${expected}`);
  });

  test('collision-response: 質量の両極でも失う力学エネルギーは有限', () => {
    // 試験粒子(逆質量 ∞)は相手を押さないが、自分は跳ね返るので比エネルギーは失う。
    const particle = overlapPair(v3(3, 0, 0), v3(), Infinity, 1 / 5, 0.4)!;
    assert.ok(Number.isFinite(particle.specificEnergyLossA) && particle.specificEnergyLossA > 0);
    assert.equal(particle.specificEnergyLossB, 0, '押されない側は失わない');
    // 相手が無限質量(逆質量 0)なら、動く側が全部を受け持つ。
    const wall = overlapPair(v3(3, 0, 0), v3(), 1 / 2, 0, 0.4)!;
    assert.ok(Number.isFinite(wall.specificEnergyLossA) && wall.specificEnergyLossA > 0);
    assert.equal(wall.specificEnergyLossB, 0);
  });

  test('collision-response: 天体との接触では、動く側が散逸の半分を受け取る', () => {
    const restitution = 0.4;
    const res = fixedContact(
      { state: kinematicState(0, v3(-0.6, 0, 0), v3(1, 0, 0)), radius: 1 },
      { state: kinematicState(0, v3(0.6, 0, 0), v3()), radius: 1 },
      restitution,
    )!;
    assert.ok(res.bounced);
    // 不動な相手との散逸は ½·m·(1−e²)·vn²。動く側が受け取るのはその半分の比量。
    const expected = 0.25 * (1 - restitution * restitution) * 1 * 1;
    assert.ok(Math.abs(res.specificEnergyLoss - expected) < 1e-12);
  });

  test('collision-response: 離反中の接触では力学エネルギーを失わない', () => {
    const res = overlapPair(v3(-1, 0, 0), v3(1, 0, 0), 1 / 2, 1 / 5, 0.4)!;
    assert.ok(!res.bounced);
    assert.equal(res.specificEnergyLossA, 0);
    assert.equal(res.specificEnergyLossB, 0);
  });
}
