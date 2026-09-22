// 接触1件の記述(game/dynamic/dynamic-entity/contact.ts)の回帰テスト。closingSpeed は
// SPEC/COMBAT.md「剛体接触によるダメージ」が根拠に据える量そのもの — 接触法線方向の
// 相対速度 — なので、掛かる重み(調整値)と違って理論値で固定できる。
//
// **法線の向きの取り決めは2つのモジュールに跨がる。** 記述を組むのは接触の解決器
// (dynamic/entity-contact-physics.ts・surface-contact-physics.ts)で、それが渡す法線は
// physics/collision-response.ts が決める。片方だけを読んでも符号は確かめられないので、
// 解決器と同じ組み方を再現して両者が噛み合っていることまで見る。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { closingSpeed, type Contact } from '../../src/game/dynamic/dynamic-entity/contact';
import {
  distributeFixedContact, distributeSphereContact, resolveSphereCollision, sphereContactGeometry,
} from '../../src/physics/collision-response';
import { type KinematicState, kinematicState } from '../../src/physics/kinematic-state';
import { type Vec3, scale, v3 } from '../../src/math/vec3';
import { DynamicMotion } from '../../src/game/dynamic/dynamic-motion';
import type { DynamicReactionServices } from '../../src/game/dynamic/dynamic-simulation-participant';
import { EntityContactPhysics } from '../../src/game/dynamic/entity-contact-physics';
import { EngagementZone } from '../../src/game/dynamic/engagement-zone';

// closingSpeed が読むのは速度と法線だけなので、時刻と接触点は退化させてよい。
function contact(selfV: Vec3, otherV: Vec3, normal: Vec3): Contact {
  return {
    t: 0, point: v3(), normal,
    selfState: kinematicState<'eci'>(0, v3(), selfV),
    otherState: kinematicState<'eci'>(0, v3(), otherV),
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
    const a = { state: kinematicState<'eci'>(0, v3(0, 0, 0), v3()), radius: 1, invMass: 1 };
    const b = { state: kinematicState<'eci'>(0, v3(1.5, 0, 0), v3(-10, 0, 0)), radius: 1, invMass: 1 };
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
    const moving = { state: kinematicState<'eci'>(0, v3(0, 0, 0), v3(8, 0, 0)), radius: 1 };
    const fixed = { state: kinematicState<'eci'>(0, v3(1.5, 0, 0), v3()), radius: 1 };
    const geometry = sphereContactGeometry(moving, fixed);
    const response = geometry === null ? null : distributeFixedContact(moving, fixed, 0.4, geometry);
    assert.ok(response !== null && response.bounced, '前提: 表面へ突っ込めば反発が起きる');
    assert.equal(closingSpeed(received(moving.state, fixed.state, response.normal)), 8);
  });

  test('contact: 固有形状の module id は反発しない重なりでも応答に残る', () => {
    const a = {
      state: kinematicState<'eci'>(0, v3(), v3()), radius: 1, invMass: 1,
    };
    const b = {
      state: kinematicState<'eci'>(0, v3(1.5, 0, 0), v3()), radius: 1, invMass: 1,
    };
    const response = distributeSphereContact(a, b, 0.4, {
      normal: v3(1, 0, 0), toi: 1, pushOut: 0.4,
      moduleIdA: 'module-a', moduleIdB: 'module-b',
    });
    assert.equal(response.bounced, false);
    assert.equal(response.moduleIdA, 'module-a');
    assert.equal(response.moduleIdB, 'module-b');
  });

  test('contact: 地表への fixed 応答も実接触点と self module id を保持する', () => {
    const moving = { state: kinematicState<'eci'>(0, v3(), v3(1, 0, 0)), radius: 4 };
    const fixed = { state: kinematicState<'eci'>(0, v3(10, 0, 0), v3()), radius: 5 };
    const point = v3(3, 2, 1);
    const response = distributeFixedContact(moving, fixed, 0.4, {
      normal: v3(1, 0, 0), toi: 0.5, pushOut: 0.25,
      contactPoint: point, moduleIdA: 'hull', moduleIdB: null,
    });
    assert.equal(response.moduleIdA, 'hull');
    assert.deepEqual(response.contactPoint, point);
  });

  test('contact: B側の固有形状は法線と module id を反転し、両側通知へ self/other を渡す', () => {
    const receivedA: Contact[] = [];
    const receivedB: Contact[] = [];
    const a = new DynamicMotion(
      kinematicState<'eci'>(0, v3(0, 0, 0), v3(1, 0, 0)),
      { radius: 1, mass: 1, collides: true, behavior: {
        onEntityContact: (_self, _other, received) => { receivedA.push(received); },
      } },
    );
    const b = new DynamicMotion(
      kinematicState<'eci'>(0, v3(1.5, 0, 0), v3(-1, 0, 0)),
      { radius: 1, mass: 1, collides: true, behavior: {
        testEntityCollision: () => ({
          normal: v3(-1, 0, 0), toi: 1, pushOut: 0.4,
          moduleIdA: 'b-self', moduleIdB: 'a-other',
        }),
        onEntityContact: (_self, _other, received) => { receivedB.push(received); },
      } },
    );
    const physics = new EntityContactPhysics();
    physics.resolveEntityContacts(0, [a, b], [new EngagementZone([a])], {} as DynamicReactionServices);

    assert.equal(receivedA.length, 1);
    assert.equal(receivedB.length, 1);
    const contactA = receivedA[0];
    const contactB = receivedB[0];
    assert.ok(contactA !== undefined && contactB !== undefined);
    assert.equal(contactA.selfModuleId, 'a-other');
    assert.equal(contactA.otherModuleId, 'b-self');
    assert.equal(contactA.normal.x, 1);
    assert.equal(Math.abs(contactA.normal.y), 0);
    assert.equal(Math.abs(contactA.normal.z), 0);
    assert.equal(contactB.selfModuleId, 'b-self');
    assert.equal(contactB.otherModuleId, 'a-other');
    assert.equal(contactB.normal.x, -1);
    assert.equal(Math.abs(contactB.normal.y), 0);
    assert.equal(Math.abs(contactB.normal.z), 0);
  });

  test('contact: 薬莢はアンカー(自艦)から30m以内のときだけ接触判定へ参加する', () => {
    const ship = new DynamicMotion(
      kinematicState<'eci'>(0, v3(0, 0, 0), v3()),
      { radius: 5, mass: 1000, collides: true, engagementAnchor: true },
    );
    const nearCasing = new DynamicMotion(
      kinematicState<'eci'>(0, v3(10, 0, 0), v3()),
      { radius: 0.5, mass: 0, collides: true, behavior: { contactKind: 'casing' } as DynamicMotion['behavior'] },
    );
    const distantCasing = new DynamicMotion(
      kinematicState<'eci'>(0, v3(50, 0, 0), v3()),
      { radius: 0.5, mass: 0, collides: true, behavior: { contactKind: 'casing' } as DynamicMotion['behavior'] },
    );

    const physics = new EntityContactPhysics();
    physics.resolveEntityContacts(
      0, [ship, nearCasing, distantCasing], [new EngagementZone([ship])], {} as DynamicReactionServices,
    );

    // 参加者は ship と nearCasing の 2 体だけで、50m 離れた distantCasing は除外される
    assert.equal(physics.participants, 2);
  });
}
