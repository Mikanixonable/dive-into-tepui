import * as assert from 'node:assert/strict';
import { add, len, sub, v3 } from '../../src/math/vec3';
import { qNormalize, qRotate } from '../../src/math/quat';
import { kinematicState, serializeKinematicState } from '../../src/physics/kinematic-state';
import { AssemblyEnemy } from '../../src/game/dynamic/dynamic-entity/assembly-enemy';
import { ASSEMBLY_PART_HP } from '../../src/game/assembly/assembly-combat-state';
import { assemblyPartDebris, type DebrisPiece } from '../../src/game/dynamic/dynamic-entity/debris-piece';
import { EntityIdAllocators } from '../../src/game/dynamic/dynamic-entity/entity-id';
import type { EntityRegistry } from '../../src/game/dynamic/entity-registry';
import { generateAssemblyShape, detachPart } from '../../src/render/assembly/assembly-shape';
import { test } from '../harness';

// 失われた部品は、部品を失った瞬間の敵の重心と姿勢を引き継いで飛ぶ(SPEC/ASSEMBLY.md「破片」)。
// 重心の位置は、敵の重心から敵の姿勢で回した重心の位置に一致する。

export function register(): void {
  test('assembly part debris: 飛び出す部品の重心は、敵の重心から敵の姿勢で回した位置に置かれる', () => {
    const seed = 7;
    const shape = generateAssemblyShape(seed);
    const part = shape.parts[0]!;
    const q = qNormalize({ x: 0.2, y: -0.4, z: 0.1, w: 0.9 });
    const state = kinematicState<'eci'>(12, v3(1000, 2000, 3000), v3(7000, 0, 0));
    const attitude = { q, w: v3(0.1, -0.2, 0.3), inertia: shape.inertia };

    const piece = assemblyPartDebris(
      state, attitude, seed, part, 0xff8800, new EntityIdAllocators(),
    );

    const center = detachPart(part).center;
    const expected = add(state.r, qRotate(q, center));
    assert.ok(len(sub(piece.motion.state.r, expected)) < 1e-6, '飛び出す部品の位置が敵の運動と合わない');
    assert.equal(piece.motion.state.t, state.t);
  });

  test('assembly part debris: 飛び出す部品は、切り出した部品の慣性を持つ', () => {
    const seed = 11;
    const shape = generateAssemblyShape(seed);
    const part = shape.parts[shape.parts.length - 1]!;
    const attitude = {
      q: qNormalize({ x: 0, y: 0, z: 0, w: 1 }), w: v3(0, 0, 0), inertia: shape.inertia,
    };

    const piece = assemblyPartDebris(
      kinematicState<'eci'>(0, v3(), v3()), attitude, seed, part, 0x1, new EntityIdAllocators(),
    );

    assert.deepEqual(piece.motion.att.inertia, detachPart(part).inertia);
  });

  test('assembly part debris: 被弾で部品が尽きると、その部品だけが破片として飛ぶ', () => {
    const seed = 7;
    const enemy = newEnemy(seed);
    const part = generateAssemblyShape(seed).parts[0]!;
    const midpoint = part.centerline[Math.floor(part.centerline.length / 2)]!;
    const impact = add(enemy.motion.state.r, qRotate(enemy.motion.att.q, midpoint));
    const added: DebrisPiece[] = [];

    // 部品 HP と同じダメージで、狙った部品だけが尽きる
    enemy['applyBulletDamage'](ASSEMBLY_PART_HP, impact, fakeRegistry(added));

    assert.deepEqual(added.map((piece) => piece.serialize().debrisKind), [
      { kind: 'assemblyPart', seed, partIndex: part.index, accent: ACCENT },
    ]);
  });

  test('assembly part debris: 本体が失われるとき、なお残っていた部品が残らず飛ぶ', () => {
    const seed = 7;
    const enemy = newEnemy(seed);
    const shape = generateAssemblyShape(seed);
    const added: DebrisPiece[] = [];

    enemy['scatterDebris'](fakeRegistry(added));

    assert.deepEqual(
      added.map((piece) => piece.serialize().debrisKind),
      shape.parts.map((part) => ({ kind: 'assemblyPart', seed, partIndex: part.index, accent: ACCENT })),
    );
  });
}

const ACCENT = 0xff8800;

// seed の個体を、固定の位置と速度へ置く。
function newEnemy(seed: number): AssemblyEnemy {
  return AssemblyEnemy.create({
    name: 'assembly-test',
    state: serializeKinematicState(kinematicState<'eci'>(0, v3(1000, 2000, 3000), v3(7000, 0, 0))),
    seed,
    accent: ACCENT,
    orbitLineColor: ACCENT,
    formationId: null,
    formationRole: null,
  }, new EntityIdAllocators());
}

// 生まれた破片を added へ集める、登録の最小の代役。
function fakeRegistry(added: DebrisPiece[]): EntityRegistry {
  return {
    add: (piece: DebrisPiece) => { added.push(piece); },
    idAllocators: new EntityIdAllocators(),
    events: { record: () => {} },
  } as unknown as EntityRegistry;
}
