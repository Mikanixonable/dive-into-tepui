// DynamicMotion の剛体物性交換契約。形状と物性を別々に更新すると接触側が世代の異なる
// 値を読むため、成功時の一括交換と失敗時の完全なロールバックを確認する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { v3 } from '../../src/math/vec3';
import { qFromAxisAngle } from '../../src/math/quat';
import { kinematicState } from '../../src/physics/kinematic-state';
import type { CompoundCylinderShape } from '../../src/physics/compound-cylinder-contact';
import { DynamicMotion } from '../../src/game/dynamic/dynamic-motion';

function shape(): CompoundCylinderShape {
  return {
    primitives: [{
      moduleId: 'tank-a', center: v3(1, 2, 3), axis: v3(0, 0, 2), halfLength: 2, radius: 1,
    }],
  };
}

function motion(): DynamicMotion {
  return new DynamicMotion(kinematicState<'eci'>(0, v3(), v3()), { mass: 2, radius: 3 });
}

export function register(): void {
  test('dynamic motion: collision properties are replaced atomically and freeze the shape snapshot', () => {
    const self = motion();
    self.trajectoryReader = true;
    const oldArc = self.ensurePredictedArc([]);
    assert.ok(oldArc !== null);
    const input = shape();
    self.replaceCollisionProperties({
      mass: 10,
      radius: 6,
      centerOfMass: v3(0.5, 0, -0.5),
      inertia: v3(4, 5, 6),
      compoundShape: input,
    });

    assert.equal(self.mass, 10);
    assert.equal(self.radius, 6);
    assert.deepEqual(self.centerOfMass, v3(0.5, 0, -0.5));
    assert.deepEqual(self.att.inertia, v3(4, 5, 6));
    assert.equal(self.shapeRevision, 1);
    assert.equal(self.arc, null);
    assert.equal(self.compoundShape?.primitives[0]?.axis.z, 1, '軸は単位化される');
    assert.notEqual(self.compoundShape, input);

    const inputPrimitive = input.primitives[0];
    assert.ok(inputPrimitive !== undefined);
    (inputPrimitive.center as { x: number }).x = 99;
    assert.equal(self.compoundShape?.primitives[0]?.center.x, 1, '入力 Vec3 を共有しない');
    const compoundShape = self.compoundShape;
    assert.ok(compoundShape !== null);
    const compoundPrimitive = compoundShape.primitives[0];
    assert.ok(compoundPrimitive !== undefined);
    assert.throws(() => { (compoundPrimitive as { radius: number }).radius = 99; }, TypeError);
    assert.throws(() => { (compoundShape.primitives as unknown[])[0] = null; }, TypeError);

    const newArc = self.ensurePredictedArc([]);
    assert.ok(newArc !== null && newArc !== oldArc, '物性交換後は予測弧を再生成する');
  });

  test('dynamic motion: invalid collision properties leave every value and arc unchanged', () => {
    const self = motion();
    self.trajectoryReader = true;
    const originalShape = shape();
    self.replaceCollisionProperties({
      mass: 4, radius: 5, centerOfMass: v3(1, 0, 0), inertia: v3(2, 3, 4), compoundShape: originalShape,
    });
    const oldArc = self.ensurePredictedArc([]);
    const before = self.collisionProperties;
    const revision = self.shapeRevision;
    assert.throws(() => self.replaceCollisionProperties({
      mass: Number.NaN, radius: 100, centerOfMass: v3(9, 9, 9), inertia: v3(9, 9, 9), compoundShape: null,
    }));
    assert.equal(self.mass, before.mass);
    assert.equal(self.radius, before.radius);
    assert.deepEqual(self.centerOfMass, before.centerOfMass);
    assert.deepEqual(self.att.inertia, before.inertia);
    assert.equal(self.compoundShape, before.compoundShape);
    assert.equal(self.shapeRevision, revision);
    assert.equal(self.arc, oldArc, '失敗時は予測弧も維持する');
  });

  test('dynamic motion: mass setter validates and invalidates prediction', () => {
    const self = motion();
    self.trajectoryReader = true;
    const arc = self.ensurePredictedArc([]);
    assert.ok(arc !== null);
    self.mass = 8;
    assert.equal(self.mass, 8);
    assert.equal(self.arc, null);
    assert.throws(() => { self.mass = Infinity; });
    assert.equal(self.mass, 8);
    self.mass = 0;
    assert.equal(self.mass, 0, '質量0の固定物体は既存契約として許可する');
  });

  test('dynamic motion: compound shape validation rejects malformed primitives', () => {
    const self = motion();
    const beforeRevision = self.shapeRevision;
    assert.throws(() => self.replaceCollisionProperties({
      mass: 1, radius: 1, centerOfMass: v3(), inertia: v3(1, 1, 1),
      compoundShape: { primitives: [{ moduleId: 'bad', center: v3(), axis: v3(), halfLength: 1, radius: 1 }] },
    }));
    assert.equal(self.shapeRevision, beforeRevision);
    assert.equal(self.compoundShape, null);
  });

  test('dynamic motion: attitude step は compound sweep 用の直前姿勢を保持する', () => {
    const before = qFromAxisAngle(v3(0, 1, 0), 0.25);
    const self = new DynamicMotion(kinematicState<'eci'>(0, v3(), v3()), {
      attitude: { q: before, w: v3(0, 0.5, 0), inertia: v3(1, 1, 1) },
    });
    self.stepSimulation(0.5, [], [], null, null, 0, {} as never);
    assert.deepEqual(self.prevAtt.q, before);
    assert.notDeepEqual(self.att.q, before);
  });

  test('dynamic motion: ray pick は外接球でなく最近傍 compound module を返す', () => {
    const self = motion();
    self.replaceCollisionProperties({
      mass: 2, radius: 10, centerOfMass: v3(), inertia: v3(1, 1, 1),
      compoundShape: {
        primitives: [{
          moduleId: 'tank', center: v3(), axis: v3(0, 0, 1), halfLength: 1, radius: 0.5,
        }],
      },
    });
    const miss = { origin: v3(-5, 3, 0), dir: v3(1, 0, 0) };
    assert.equal(self.intersectsRay(miss, v3()), false, '外接球だけへ当たる ray は外す');
    const hitRay = { origin: v3(-5, 0, 0), dir: v3(1, 0, 0) };
    assert.equal(self.intersectsRay(hitRay, v3()), true);
    assert.equal(self.raycastCompound(hitRay, v3())?.moduleId, 'tank');
  });
}
