// DynamicMotion の compound cylinder を、entity 接触の狭域判定へ渡す回帰テスト。
// 広域の外接球は候補を拾うためだけに使い、接触の成否・TOI・module id・点は primitive
// 集合から決まることを固定する。
import * as assert from 'node:assert/strict';
import { Q_IDENTITY, qFromAxisAngle, type Quat } from '../../src/math/quat';
import { v3 } from '../../src/math/vec3';
import { kinematicState } from '../../src/physics/kinematic-state';
import type { Attitude } from '../../src/physics/attitude';
import type { CompoundCylinderShape } from '../../src/physics/compound-cylinder-contact';
import { DynamicMotion } from '../../src/game/dynamic/dynamic-motion';
import { entityContactResponse } from '../../src/game/dynamic/entity-contact-response';
import { test } from '../harness';

const INERTIA = v3(1, 1, 1);

function cylinder(moduleId: string, center = v3(), axis = v3(0, 1, 0), halfLength = 1, radius = 0.5) {
  return { moduleId, center, axis, halfLength, radius };
}

function motion(
  position: ReturnType<typeof v3>, shape: CompoundCylinderShape, radius: number,
): DynamicMotion {
  const result = new DynamicMotion(
    kinematicState<'eci'>(0, position, v3()),
    {
      attitude: attitude(Q_IDENTITY), mass: 1, radius, collides: true,
    },
  );
  result.replaceCollisionProperties({
    mass: 1, radius, centerOfMass: v3(), inertia: INERTIA, compoundShape: shape,
  });
  return result;
}

function sphere(position: ReturnType<typeof v3>, radius: number): DynamicMotion {
  return new DynamicMotion(
    kinematicState<'eci'>(0, position, v3()),
    {
      attitude: attitude(Q_IDENTITY), mass: 1, radius, collides: true,
    },
  );
}

function attitude(q: Quat): Attitude {
  return { q, w: v3(), inertia: INERTIA };
}

function advance(
  entity: DynamicMotion, position: ReturnType<typeof v3>, rotation: Quat,
  previousRotation: Quat = entity.att.q,
): void {
  entity.prevAtt = attitude(previousRotation);
  entity.att = { ...entity.att, q: rotation };
  entity.reset(kinematicState<'eci'>(1, position, v3()));
}

export function register(): void {
  test('entity compound: compound と sphere は実接触点・法線・module id を返す', () => {
    const compound = motion(v3(1, 0, 0), {
      primitives: [cylinder('tank', v3(), v3(0, 1, 0), 1, 0.5)],
    }, 2);
    const ball = sphere(v3(), 0.5);
    const response = entityContactResponse(ball, ball.state, compound, compound.state);

    assert.ok(response !== null);
    assert.equal(response.moduleIdA, null);
    assert.equal(response.moduleIdB, 'tank');
    assert.ok(response.contactPoint !== null);
    assert.ok(response.contactPoint.x > 0.4 && response.contactPoint.x < 0.7);
    assert.ok(response.normal.x > 0.99, '法線は sphere(A) から compound(B)');
  });

  test('entity compound: compound 同士は両側の module id と A→B 法線を保持する', () => {
    const a = motion(v3(), { primitives: [cylinder('a')] }, 1);
    const b = motion(v3(0.8, 0, 0), { primitives: [cylinder('b')] }, 1);
    const response = entityContactResponse(a, a.state, b, b.state);

    assert.ok(response !== null);
    assert.equal(response.moduleIdA, 'a');
    assert.equal(response.moduleIdB, 'b');
    assert.ok(response.normal.x > 0.99, '法線は A から B');
    assert.ok(response.contactPoint !== null);
  });

  test('entity compound: 高速並進を始点終点の外側でも掃引し、最初の TOI を返す', () => {
    const moving = motion(v3(-5, 0, 0), {
      primitives: [cylinder('moving', v3(), v3(0, 1, 0), 0.5, 0.3)],
    }, 6);
    const target = sphere(v3(), 0.3);
    advance(moving, v3(5, 0, 0), Q_IDENTITY);
    advance(target, v3(), Q_IDENTITY);

    const response = entityContactResponse(moving, moving.state, target, target.state);
    assert.ok(response !== null);
    assert.equal(response.moduleIdA, 'moving');
    assert.ok(response.toi > 0.3 && response.toi < 0.7, `toi=${response.toi}`);
  });

  test('entity compound: 高速回転を姿勢補間して掃引する', () => {
    const moving = motion(v3(), {
      // 始点では z 軸、終点では x 軸になる長い円柱。
      primitives: [cylinder('arm', v3(0, 0, 4), v3(0, 0, 1), 4, 0.15)],
    }, 4.3);
    const target = sphere(v3(4, 0, 0), 0.2);
    advance(moving, v3(), qFromAxisAngle(v3(0, 1, 0), Math.PI / 2), Q_IDENTITY);
    advance(target, v3(4, 0, 0), Q_IDENTITY);

    const response = entityContactResponse(moving, moving.state, target, target.state);
    assert.ok(response !== null);
    assert.equal(response.moduleIdA, 'arm');
    assert.ok(response.toi > 0 && response.toi < 1, `toi=${response.toi}`);
  });

  test('entity compound: 外接球だけが重なる空間では偽陽性を返さない', () => {
    const a = motion(v3(), { primitives: [cylinder('a')] }, 4);
    const b = sphere(v3(2.5, 0, 0), 0.1);
    assert.equal(entityContactResponse(a, a.state, b, b.state), null);
  });
}
