import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  ASSEMBLY_PART_HP, AssemblyCombatState,
} from '../../src/game/assembly/assembly-combat-state';
import {
  generateAssemblyShape, type AssemblyPartRole, type AssemblyShape,
} from '../../src/render/assembly/assembly-shape';

// role を持つ部品の index。
function roleIndex(shape: AssemblyShape, role: AssemblyPartRole): number {
  const part = shape.parts.find((entry) => entry.role === role);
  assert.ok(part, `the shape has no ${role} part`);
  return part.index;
}

export function register(): void {
  // seed 1 は発射部・中核・構造部 2 個の4部品になる。
  const shape = generateAssemblyShape(1);
  const structureIndex = roleIndex(shape, 'structure');

  test('assembly combat: a bullet damages both the hit part and the integrity', () => {
    const state = new AssemblyCombatState(shape);
    // 部品の HP を残す1発は、部品を失わせず integrity だけを削る。
    const lost = state.applyBulletDamage(ASSEMBLY_PART_HP - 1, structureIndex);
    assert.equal(lost, null);
    assert.equal(state.partAlive(structureIndex), true);
    assert.equal(state.integrity, state.maxIntegrity - (ASSEMBLY_PART_HP - 1));
    assert.equal(state.destroyed, false);
  });

  test('assembly combat: a lost part is reported once and never again', () => {
    const state = new AssemblyCombatState(shape);
    const lost = state.applyBulletDamage(ASSEMBLY_PART_HP, structureIndex);
    assert.equal(lost, structureIndex);
    assert.equal(state.partAlive(structureIndex), false);
    assert.equal(state.applyBulletDamage(ASSEMBLY_PART_HP, structureIndex), null);
  });

  test('assembly combat: a bullet without a part damages only the integrity', () => {
    const state = new AssemblyCombatState(shape);
    assert.equal(state.applyBulletDamage(1, null), null);
    assert.equal(state.integrity, state.maxIntegrity - 1);
    for (const part of shape.parts) assert.equal(state.partAlive(part.index), true);
  });

  test('assembly combat: losing the core destroys the enemy', () => {
    const state = new AssemblyCombatState(shape);
    state.applyBulletDamage(ASSEMBLY_PART_HP, roleIndex(shape, 'core'));
    assert.equal(state.destroyed, true);
  });

  test('assembly combat: losing the emitter stops firing without destroying the enemy', () => {
    const state = new AssemblyCombatState(shape);
    assert.equal(state.emitterAlive, true);
    state.applyBulletDamage(ASSEMBLY_PART_HP, roleIndex(shape, 'emitter'));
    assert.equal(state.emitterAlive, false);
    assert.equal(state.destroyed, false);
  });

  test('assembly combat: exhausting the integrity destroys the enemy', () => {
    const state = new AssemblyCombatState(shape);
    state.applyIntegrityDamage(state.maxIntegrity);
    assert.equal(state.integrity, 0);
    assert.equal(state.destroyed, true);
  });

  test('assembly combat: losing every part destroys the enemy', () => {
    const state = new AssemblyCombatState(shape);
    for (const part of shape.parts) state.applyBulletDamage(ASSEMBLY_PART_HP, part.index);
    assert.equal(state.destroyed, true);
  });

  test('assembly combat: serialize and deserialize preserve the damage state', () => {
    const state = new AssemblyCombatState(shape);
    state.applyBulletDamage(ASSEMBLY_PART_HP, structureIndex);
    state.applyBulletDamage(ASSEMBLY_PART_HP - 1, roleIndex(shape, 'emitter'));
    const restored = AssemblyCombatState.deserialize(state.serialize(), shape);
    assert.equal(restored.integrity, state.integrity);
    for (const part of shape.parts) {
      assert.equal(restored.partAlive(part.index), state.partAlive(part.index));
    }
    assert.equal(restored.destroyed, state.destroyed);
    assert.equal(restored.emitterAlive, state.emitterAlive);
    assert.deepEqual(restored.serialize(), state.serialize());

    // 全部品を失った記録は、integrity が残っていても撃破として復元される。
    const allLost = AssemblyCombatState.deserialize(
      { partHp: shape.parts.map(() => 0), integrity: state.maxIntegrity }, shape,
    );
    assert.equal(allLost.destroyed, true);
  });
}
