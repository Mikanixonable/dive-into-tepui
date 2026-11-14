import * as assert from 'node:assert/strict';
import { add, len, sub, v3 } from '../../src/math/vec3';
import {
  detachedPartOf, detachPart, generateAssemblyShape,
} from '../../src/render/assembly/assembly-shape';
import { test } from '../harness';

// 失われた部品を重心まわりの独立した物体として切り出す契約(SPEC/ASSEMBLY.md「破片」)。
// 切り出した形は元の位置へ戻せ、同じ seed と部品番号からは同じ切り出しが再現される。

export function register(): void {
  test('assembly detach: 切り出した部品の重心は原点にあり、元の位置へ戻せる', () => {
    for (let seed = 0; seed < 60; seed += 1) {
      for (const part of generateAssemblyShape(seed).parts) {
        const detached = detachPart(part);
        let sum = v3(0, 0, 0);
        for (const point of detached.part.centerline) sum = add(sum, point);
        const mean = len(sum) / detached.part.centerline.length;
        assert.ok(mean < 1e-9, `seed ${seed} part ${part.index}: 重心が原点にない(${mean})`);
        part.centerline.forEach((point, i) => {
          const back = add(detached.part.centerline[i]!, detached.center);
          assert.ok(len(sub(back, point)) < 1e-9, `seed ${seed} part ${part.index}: 元の位置へ戻らない`);
        });
      }
    }
  });

  test('assembly detach: 切り出しは部品の番号・役割・種別・管半径を保ち、慣性は最大成分で正規化される', () => {
    for (let seed = 0; seed < 60; seed += 1) {
      for (const part of generateAssemblyShape(seed).parts) {
        const detached = detachPart(part);
        assert.equal(detached.part.index, part.index);
        assert.equal(detached.part.role, part.role);
        assert.equal(detached.part.kind, part.kind);
        assert.equal(detached.part.radius, part.radius);
        const { inertia } = detached;
        for (const component of [inertia.x, inertia.y, inertia.z]) {
          assert.ok(Number.isFinite(component) && component >= 0 && component <= 1 + 1e-12);
        }
        assert.ok(Math.max(inertia.x, inertia.y, inertia.z) > 1 - 1e-12);
      }
    }
  });

  test('assembly detach: 同じ seed と部品番号からは同じ切り出しが再現される', () => {
    for (const seed of [0, 17, 42]) {
      const shape = generateAssemblyShape(seed);
      for (const part of shape.parts) {
        assert.deepEqual(detachedPartOf(seed, part.index), detachPart(part));
      }
    }
  });
}
