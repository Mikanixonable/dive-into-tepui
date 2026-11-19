import * as assert from 'node:assert/strict';
import { len, sub } from '../../src/math/vec3';
import { generateAssemblyShape } from '../../src/render/assembly/assembly-shape';
import { test } from '../harness';

// 生成器が満たすべき不変条件(SPEC/ASSEMBLY.md)。形状の見た目ではなく契約を固定する。

export function register(): void {
  test('assembly shape: 同じ seed から同じ形が再現される', () => {
    const a = generateAssemblyShape(42);
    const b = generateAssemblyShape(42);
    assert.deepEqual(a, b);
  });

  test('assembly shape: すべての個体が発射部と中核を1つずつ持つ', () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const shape = generateAssemblyShape(seed);
      const emitters = shape.parts.filter((part) => part.role === 'emitter');
      const cores = shape.parts.filter((part) => part.role === 'core');
      assert.equal(emitters.length, 1, `seed ${seed}: emitter ${emitters.length}`);
      assert.equal(cores.length, 1, `seed ${seed}: core ${cores.length}`);
      assert.notEqual(emitters[0]!.index, cores[0]!.index, `seed ${seed}: emitter と core が同じ部品`);
    }
  });

  test('assembly shape: 外接半径は仕様の範囲で、全頂点が内側に収まる', () => {
    for (let seed = 0; seed < 100; seed += 1) {
      const shape = generateAssemblyShape(seed);
      assert.ok(shape.outerRadius >= 40 && shape.outerRadius <= 70, `seed ${seed}: ${shape.outerRadius}`);
      for (const part of shape.parts) {
        for (const point of part.centerline) {
          assert.ok(
            Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z),
            `seed ${seed} part ${part.index}: 非有限な頂点`,
          );
          assert.ok(
            len(point) + part.radius <= shape.outerRadius + 1e-6,
            `seed ${seed} part ${part.index}: 外接半径を超える頂点`,
          );
        }
      }
    }
  });

  test('assembly shape: 各部品の折れ線は長さを持ち、発射部の先端はその部品の端である', () => {
    for (let seed = 0; seed < 100; seed += 1) {
      const shape = generateAssemblyShape(seed);
      for (const part of shape.parts) {
        assert.ok(part.centerline.length >= 2, `seed ${seed} part ${part.index}: 頂点が足りない`);
        let length = 0;
        for (let i = 0; i + 1 < part.centerline.length; i += 1) {
          length += len(sub(part.centerline[i + 1]!, part.centerline[i]!));
        }
        if (part.closed) {
          // 閉ループは最初と最後の頂点が一致する
          assert.ok(
            len(sub(part.centerline[0]!, part.centerline[part.centerline.length - 1]!)) < 1e-6,
            `seed ${seed} part ${part.index}: 閉ループが閉じていない`,
          );
        } else {
          assert.ok(length > part.radius, `seed ${seed} part ${part.index}: 退化した折れ線`);
        }
      }
      const emitter = shape.parts.find((part) => part.role === 'emitter')!;
      const first = emitter.centerline[0]!;
      const last = emitter.centerline[emitter.centerline.length - 1]!;
      const onEnd = len(sub(shape.emitterTip, first)) < 1e-6 || len(sub(shape.emitterTip, last)) < 1e-6;
      assert.ok(onEnd, `seed ${seed}: emitterTip が発射部の端にない`);
    }
  });
}
