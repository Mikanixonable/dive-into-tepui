// 接触1件の記述(game/game-entity/contact.ts)の回帰テスト。closingSpeed は
// SPEC/COMBAT.md「剛体接触によるダメージ」が根拠に据える量そのもの — 接触法線方向の
// 相対速度 — なので、掛かる重み(調整値)と違って理論値で固定できる。
//
// **法線の向きの取り決めは2つのモジュールに跨がる。** 記述を組むのは接触の解決器
// (simulation/entity-contact-physics.ts・surface-contact-physics.ts)で、それが渡す法線は
// physics/collision-response.ts が決める。片方だけを読んでも符号は確かめられないので、
// 解決器と同じ組み方を再現して両者が噛み合っていることまで見る。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { closingSpeed, type Contact } from '../../src/game/game-entity/contact';
import {
  distributeFixedContact, resolveSphereCollision, sphereContactGeometry,
} from '../../src/physics/collision-response';
import { KinematicState, kinematicState } from '../../src/physics/kinematic-state';
import { Vec3, scale, v3 } from '../../src/math/vec3';

// closingSpeed が読むのは速度と法線だけなので、時刻と接触点は退化させてよい。
function contact(selfV: Vec3, otherV: Vec3, normal: Vec3): Contact {
  return {
    t: 0, point: v3(), normal,
    selfState: kinematicState(0, v3(), selfV),
    otherState: kinematicState(0, v3(), otherV),
  };
}

// 解決器が反発の結果から受け手ごとの記述を組むのと同じ形。
function received(selfState: KinematicState, otherState: KinematicState, normal: Vec3): Contact {
  return { t: 0, point: v3(), normal, selfState, otherState };
}

export function register(): void {
  test('contact: closingSpeed は接触法線方向の相対速度で、近づいているときに正になる', () => {
    const toOther = v3(1, 0, 0);
    assert.equal(closingSpeed(contact(v3(3, 0, 0), v3(), toOther)), 3, '相手へ 3 m/s で近づく');
    assert.equal(closingSpeed(contact(v3(), v3(-3, 0, 0), toOther)), 3, '相手が 3 m/s で寄ってくる');
    assert.equal(closingSpeed(contact(v3(3, 0, 0), v3(3, 0, 0), toOther)), 0, '並走は近づいていない');
    assert.equal(closingSpeed(contact(v3(0, 100, 0), v3(), toOther)), 0, '法線と直交する運動は寄与しない');
    assert.equal(closingSpeed(contact(v3(3, 4, 0), v3(), toOther)), 3, '斜めの接近は法線成分だけ残る');
  });

  test('contact: closingSpeed は離反していれば 0 で、負にはならない', () => {
    const toOther = v3(1, 0, 0);
    assert.equal(closingSpeed(contact(v3(-5, 0, 0), v3(), toOther)), 0, '自分が離れていく');
    assert.equal(closingSpeed(contact(v3(), v3(5, 0, 0), toOther)), 0, '相手が離れていく');
  });

  test('contact: 物体どうしの反発が起きたとき、両当事者の見る接近速度は正で一致する', () => {
    // resolveSphereCollision が bounced を立てるのは接近しているときだけなので、そこから
    // 組んだ記述の接近速度が 0 になるなら、法線の向きか符号のどちらかが食い違っている。
    const a = { state: kinematicState(0, v3(0, 0, 0), v3()), radius: 1, invMass: 1 };
    const b = { state: kinematicState(0, v3(1.5, 0, 0), v3(-10, 0, 0)), radius: 1, invMass: 1 };
    const response = resolveSphereCollision(a, b, 0.4);
    assert.ok(response !== null && response.bounced, '前提: 正面衝突で反発が起きる');
    // 解決器は同じ結果から self/other を入れ替えた記述を2つ作り、法線も反転させる。
    const aView = received(a.state, b.state, response.normal);
    const bView = received(b.state, a.state, scale(response.normal, -1));
    assert.equal(closingSpeed(aView), 10);
    assert.equal(closingSpeed(bView), 10);
  });

  test('contact: 天体表面との反発が起きたときも、接近速度は正になる', () => {
    // 表面接触の法線は「動く側 → 相手」で、受け手はいつも動く側。
    const moving = { state: kinematicState(0, v3(0, 0, 0), v3(8, 0, 0)), radius: 1 };
    const fixed = { state: kinematicState(0, v3(1.5, 0, 0), v3()), radius: 1 };
    const geometry = sphereContactGeometry(moving, fixed);
    const response = geometry === null ? null : distributeFixedContact(moving, fixed, 0.4, geometry);
    assert.ok(response !== null && response.bounced, '前提: 表面へ突っ込めば反発が起きる');
    assert.equal(closingSpeed(received(moving.state, fixed.state, response.normal)), 8);
  });
}
