// surface-contact.ts の回帰テスト。窓の中から「最初に触れる1体」を選ぶところだけを見る
// (掃引の幾何そのものは sphere-contact.test.ts、反発の分配は collision-response.test.ts)。
import { fixedMotion } from './test-helpers';
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { CelestialMotion } from '../../src/physics/celestial-motion';
import { firstSurfaceContact } from '../../src/physics/surface-contact';
import { hermiteInterpolate, kinematicState } from '../../src/physics/kinematic-state';
import { MU_EARTH, R_EARTH } from '../../src/game/celestial/solar-system/constants';
import { len, sub, v3 } from '../../src/math/vec3';

const ZERO = v3(0, 0, 0);
const EARTH: CelestialMotion = fixedMotion({
  id: 'earth', mu: MU_EARTH, radius: R_EARTH, state: kinematicState<'eci'>(0, ZERO, ZERO),
  accel: ZERO, degree2: null, atmosphere: null,
});

// 位置・速度・半径だけを持つ天体。重力も大気も表面判定には効かない。
function body(id: string, r = ZERO, v = ZERO, radius = 500): CelestialMotion {
  return fixedMotion({
    id, mu: 0, radius, state: kinematicState<'eci'>(0, r, v),
    accel: ZERO, degree2: null, atmosphere: null,
  });
}

export function register(): void {
  // 高ワープでは1ステップが最大20秒 = 軌道速度で約156km になり、点判定では小天体を丸ごと
  // 素通りする。掃引判定がその貫通を捉えることがこの関数の存在理由。
  test('firstSurfaceContact: 1ステップで小天体を貫通する経路を捉える(点判定は見逃す)', () => {
    const rock = body('rock');
    const vel = v3(7800, 0, 0);
    const prev = kinematicState<'eci'>(0, v3(-78e3, 0, 0), vel);
    const next = kinematicState<'eci'>(20, v3(78e3, 0, 0), vel);

    assert.equal(firstSurfaceContact(prev, next, 0, [rock], 0)?.body, rock);
  });

  // toi から補間した状態が ✕ マーカーの位置になるので、天体の表面上でなければならない。
  test('firstSurfaceContact: 掃引で捉えた toi は区間の途中で、補間すると天体表面上に載る', () => {
    const rock = body('rock');
    const vel = v3(7800, 0, 0);
    const prev = kinematicState<'eci'>(0, v3(-78e3, 0, 0), vel);
    const next = kinematicState<'eci'>(20, v3(78e3, 0, 0), vel);

    const hit = firstSurfaceContact(prev, next, 0, [rock], 0);
    assert.ok(hit, 'contact should be detected');
    const { toi } = hit!.geometry;
    assert.ok(toi > 0 && toi < 1, `toi ${toi} should fall inside the step`);
    const at = hermiteInterpolate(prev, next, prev.t + (next.t - prev.t) * toi);
    const dist = len(sub(at.r, rock.stateAt(0).r));
    assert.ok(Math.abs(dist - rock.def.radius) < 1, `impact should sit on the surface, ${dist} m vs ${rock.def.radius} m`);
    // 掃引は最初の接触を返すので、進行方向の手前側(x < 0)の表面に載る。
    assert.ok(at.r.x < 0, `impact should be on the approaching side, x = ${at.r.x}`);
  });

  test('firstSurfaceContact: 表面に触れない近傍通過は検出しない', () => {
    const rock = body('rock', v3(0, 600, 0));
    const vel = v3(7800, 0, 0);
    const prev = kinematicState<'eci'>(0, v3(-78e3, 0, 0), vel);
    const next = kinematicState<'eci'>(20, v3(78e3, 0, 0), vel);
    assert.equal(firstSurfaceContact(prev, next, 0, [rock], 0), null);
  });

  // 天体が1ステップの間に動くことでだけ成立する接触。天体を静止させて掃引すると取りこぼす。
  test('firstSurfaceContact: 天体自身が区間の間に動いて当たる経路を捉える', () => {
    const moving = body('moving', v3(0, -10e3, 0), v3(0, 1000, 0));
    const still = body('still', v3(0, -10e3, 0));
    const prev = kinematicState<'eci'>(0, ZERO, ZERO);
    const next = kinematicState<'eci'>(20, ZERO, ZERO);

    assert.equal(firstSurfaceContact(prev, next, 0, [still], 0), null);
    const hit = firstSurfaceContact(prev, next, 0, [moving], 0);
    assert.equal(hit?.body, moving);
    const { toi } = hit!.geometry;
    assert.ok(toi > 0 && toi < 1, `toi ${toi}`);
  });

  test('firstSurfaceContact: 動いている天体の表面に触れない通過は検出しない', () => {
    const moving = body('moving', v3(600, -10e3, 0), v3(0, 1000, 0));
    assert.equal(
      firstSurfaceContact(kinematicState<'eci'>(0, ZERO, ZERO), kinematicState<'eci'>(20, ZERO, ZERO), 0, [moving], 0),
      null);
  });

  // 掃引は「跨いだ瞬間」を返すので、始点で既に沈んでいる相手には空振りする。区間終端の
  // 重なりへ落ちて、押し戻しの幾何(toi = 1)としてその天体を返す。
  test('firstSurfaceContact: 開始時点で既に内部にいる場合もその天体を返す', () => {
    const inside = kinematicState<'eci'>(0, v3(R_EARTH - 1e3, 0, 0), ZERO);
    const later = kinematicState<'eci'>(20, v3(R_EARTH - 2e3, 0, 0), ZERO);
    const hit = firstSurfaceContact(inside, later, 0, [EARTH], 0);
    assert.equal(hit?.body, EARTH);
    assert.equal(hit!.geometry.toi, 1);
  });

  test('firstSurfaceContact: 区間の無い(prev === next)入力は区間終端の重なりだけを見る', () => {
    const outside = kinematicState<'eci'>(0, v3(R_EARTH + 420e3, 0, 0), ZERO);
    assert.equal(firstSurfaceContact(outside, outside, 0, [EARTH], 0), null);
    const inside = kinematicState<'eci'>(0, v3(R_EARTH - 1, 0, 0), ZERO);
    assert.equal(firstSurfaceContact(inside, inside, 0, [EARTH], 0)?.body, EARTH);
  });

  test('firstSurfaceContact: 非有限な入力は接触なしとして扱う', () => {
    const rock = body('rock');
    const vel = v3(7800, 0, 0);
    const next = kinematicState<'eci'>(20, v3(78e3, 0, 0), vel);
    assert.equal(firstSurfaceContact(kinematicState<'eci'>(0, v3(NaN, 0, 0), vel), next, 0, [rock], 0), null);
    const prev = kinematicState<'eci'>(0, v3(-78e3, 0, 0), vel);
    assert.equal(
      firstSurfaceContact(prev, kinematicState<'eci'>(20, v3(NaN, 0, 0), vel), 0, [rock], 0), null);
  });

  // 触れ合ったとみなす距離は天体の表面半径に判定される物体自身の半径を足したもの
  // (SPEC/ORBIT.md「天体表面への到達判定」)。実体も予測弧も同じこの関数を通るので、
  // 半径を無視する実装へ戻すと、実体が触れる配置で弧だけが素通りする状態が復活する。
  test('firstSurfaceContact: 半径和で判定する — 天体半径だけでは掠める経路を捉える', () => {
    const rock = body('rock');
    const vel = v3(7800, 0, 0);
    // 最接近は天体中心から 503 m。天体半径 500 m だけでは触れず、半径 10 m の物体なら触れる。
    const prev = kinematicState<'eci'>(0, v3(-78e3, 503, 0), vel);
    const next = kinematicState<'eci'>(20, v3(78e3, 503, 0), vel);

    assert.equal(firstSurfaceContact(prev, next, 0, [rock], 0), null, '大きさを持たない点は掠める');
    assert.equal(firstSurfaceContact(prev, next, 10, [rock], 0)?.body, rock, '半径 10 m なら触れる');
  });

  // 窓に何体入っていても解決されるのは1件で、それは区間内で最も早く触れる相手でなければ
  // ならない — 後ろの天体を先に返すと、貫いた手前の天体が無かったことになる。
  test('firstSurfaceContact: 複数が触れうるときは最も早い1体を選ぶ', () => {
    const near = body('near', v3(20e3, 0, 0));
    const far = body('far', v3(60e3, 0, 0));
    const vel = v3(7800, 0, 0);
    const prev = kinematicState<'eci'>(0, v3(-78e3, 0, 0), vel);
    const next = kinematicState<'eci'>(20, v3(78e3, 0, 0), vel);

    assert.equal(firstSurfaceContact(prev, next, 0, [near, far], 0)?.body, near);
    assert.equal(firstSurfaceContact(prev, next, 0, [far, near], 0)?.body, near);
  });
}
