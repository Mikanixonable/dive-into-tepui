import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { AssemblyCollision } from '../../src/game/assembly/assembly-collision';
import {
  generateAssemblyShape, type AssemblyPartDef,
} from '../../src/render/assembly/assembly-shape';
import { add, len, scale, v3 } from '../../src/math/vec3';
import { Q_IDENTITY, qFromAxisAngle } from '../../src/math/quat';
import { kinematicState } from '../../src/physics/kinematic-state';

// x 軸に沿った2部品(原点と z=100)。触れ合わない位置に置く。
function twoSeparatedParts(): AssemblyPartDef[] {
  return [
    {
      index: 0, role: 'emitter', kind: 'tube', radius: 1, closed: false,
      centerline: [v3(-5, 0, 0), v3(5, 0, 0)],
    },
    {
      index: 1, role: 'core', kind: 'tube', radius: 1, closed: false,
      centerline: [v3(-5, 0, 100), v3(5, 0, 100)],
    },
  ];
}

export function register(): void {
  // seed 1 は管だけ、seed 7 は結び目部品を含む。
  for (const seed of [1, 7]) {
    const shape = generateAssemblyShape(seed);

    test(`assembly collision: seed ${seed} sphere chains cover every centerline point`, () => {
      const collision = new AssemblyCollision(shape.parts);
      for (const part of shape.parts) {
        // 中心線上に置いた小球は、必ず管の内側にある。頂点だけでなく線分の中点も見る —
        // 頂点の間隔が開くところで折れ線が覆われていることの確認。
        const points = part.centerline.flatMap((vertex, index) => {
          const next = part.centerline[index + 1];
          return next === undefined ? [vertex] : [vertex, scale(add(vertex, next), 0.5)];
        });
        for (const point of points) {
          const hit = collision.testSphereCollision(
            point, part.radius * 0.5, v3(), Q_IDENTITY,
          );
          assert.ok(hit, `a point of part ${part.index} is outside every collision sphere`);
        }
      }
    });

    test(`assembly collision: seed ${seed} outer radius covers all parts`, () => {
      const collision = new AssemblyCollision(shape.parts);
      let reach = 0;
      for (const part of shape.parts) {
        for (const vertex of part.centerline) {
          reach = Math.max(reach, len(vertex) + part.radius);
        }
      }
      assert.ok(collision.outerRadius >= reach);
    });
  }

  test('assembly collision: an excluded part no longer collides nor is picked', () => {
    const collision = new AssemblyCollision(twoSeparatedParts());
    assert.ok(collision.testSphereCollision(v3(0, 0, 0), 1, v3(), Q_IDENTITY));
    assert.equal(collision.partAt(v3(0, 0, 0)), 0);

    collision.excludePart(0);
    assert.equal(collision.testSphereCollision(v3(0, 0, 0), 1, v3(), Q_IDENTITY), null);
    assert.ok(collision.testSphereCollision(v3(0, 0, 100), 1, v3(), Q_IDENTITY));
    assert.equal(collision.partAt(v3(0, 0, 0)), 1);

    collision.excludePart(1);
    assert.equal(collision.testSphereCollision(v3(0, 0, 100), 1, v3(), Q_IDENTITY), null);
    assert.equal(collision.partAt(v3(0, 0, 0)), null);
  });

  test('assembly collision: partAt compares distances to the tube surface', () => {
    const collision = new AssemblyCollision([
      {
        index: 0, role: 'structure', kind: 'tube', radius: 6, closed: false,
        centerline: [v3(-10, 0, 0), v3(10, 0, 0)],
      },
      {
        index: 1, role: 'core', kind: 'tube', radius: 1, closed: false,
        centerline: [v3(-10, 0, 30), v3(10, 0, 30)],
      },
    ]);
    // 太い管の中心から 15 の点は、表面まで 9 と 14 で太い管のほうが近い。
    assert.equal(collision.partAt(v3(0, 0, 15)), 0);
    // 同じ点が細い管の表面へ近づけば細い管を返す。
    assert.equal(collision.partAt(v3(0, 0, 25)), 1);
  });

  test('assembly collision: a sphere crossing a part between frames hits', () => {
    const collision = new AssemblyCollision(twoSeparatedParts());
    const previous = kinematicState<'eci'>(0, v3(), v3());
    const current = kinematicState<'eci'>(1, v3(), v3());
    const swept = collision.testSweptSphereCollision(
      v3(0, 50, 0), v3(0, -50, 0), 1, previous, current, Q_IDENTITY, Q_IDENTITY,
    );
    assert.ok(swept, 'a sphere crossing the part between frames should hit');
    const missed = collision.testSweptSphereCollision(
      v3(100, 50, 0), v3(100, -50, 0), 1, previous, current, Q_IDENTITY, Q_IDENTITY,
    );
    assert.equal(missed, null, 'a sphere passing outside every part should miss');
  });

  test('assembly collision: a rotating shape is swept between attitudes', () => {
    const collision = new AssemblyCollision([{
      index: 0, role: 'core', kind: 'tube', radius: 1, closed: false,
      centerline: [v3(8, 0, 0), v3(12, 0, 0)],
    }]);
    const previous = kinematicState<'eci'>(0, v3(), v3());
    const current = kinematicState<'eci'>(1, v3(), v3());
    const flipped = qFromAxisAngle(v3(0, 0, 1), Math.PI);
    // z 軸まわりの半回転で、部品は途中で +y 側の静止球の位置を通る。
    const hit = collision.testSweptSphereCollision(
      v3(0, 15, 0), v3(0, 15, 0), 6, previous, current, Q_IDENTITY, flipped,
    );
    assert.ok(hit, 'a rotating part should hit between frames');
    assert.equal(
      collision.testSphereCollision(v3(0, 15, 0), 6, v3(), Q_IDENTITY), null,
      'the initial attitude should miss',
    );
    assert.equal(
      collision.testSphereCollision(v3(0, 15, 0), 6, v3(), flipped), null,
      'the final attitude should miss',
    );
  });
}
