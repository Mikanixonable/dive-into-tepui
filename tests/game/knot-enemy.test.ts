import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { v3 } from '../../src/math/vec3';
import { kinematicState } from '../../src/physics/kinematic-state';
import {
  generateKnotShape, knotParamsFromSeed,
} from '../../src/game/knot/knot-shape';
import {
  KNOT_CORE_HP, KNOT_NODE_HP, KNOT_SEGMENT_HP, KnotCombatState,
} from '../../src/game/knot/knot-combat-state';
import { KnotCollision } from '../../src/game/knot/knot-collision';
import { KnotEnemy } from '../../src/game/dynamic/dynamic-entity/knot-enemy';
import { isSerializedEnemy } from '../../src/game/dynamic/dynamic-entity/enemy';
import { findEntityClass } from '../../src/game/dynamic/dynamic-entity/entity-dictionary';
import { EntityIdAllocators } from '../../src/game/dynamic/dynamic-entity/entity-id';
import { RunEventLog } from '../../src/game/run-events';
import type { EntityRegistry } from '../../src/game/dynamic/entity-registry';
import { generateKnotEnemy } from '../../src/game/stages/spawner/enemy-generator';

const IDENTITY_Q = { x: 0, y: 0, z: 0, w: 1 };
const ORIGIN = v3(0, 0, 0);

function stubRegistry(idAllocators: EntityIdAllocators): EntityRegistry {
  return {
    idAllocators,
    events: new RunEventLog(),
    add: () => {},
    spawnWhenReady: () => {},
    pendingEnemyCount: 0,
  };
}

export function register(): void {
  const shape = generateKnotShape(knotParamsFromSeed(7));
  const segmentIndex = shape.segments[Math.floor(shape.segments.length / 2)]!.index;
  const shooterIndex = shape.nodes.find((node) => node.role === 'shooter')!.index;

  test('knot combat: a bullet damages only the hit part, not the integrity', () => {
    const state = new KnotCombatState(shape);
    const lost = state.applyBulletDamage(KNOT_SEGMENT_HP - 1, { part: 'segment', index: segmentIndex });
    assert.equal(lost, null);
    assert.equal(state.segmentAlive(segmentIndex), true);
    assert.equal(state.integrity, state.maxIntegrity);
    const lostNode = state.applyBulletDamage(KNOT_NODE_HP, { part: 'node', index: shooterIndex });
    assert.deepEqual(lostNode, { part: 'node', index: shooterIndex });
    assert.equal(state.nodeAlive(shooterIndex), false);
    assert.equal(state.integrity, state.maxIntegrity);
  });

  test('knot combat: a lost part is reported once and never again', () => {
    const state = new KnotCombatState(shape);
    assert.deepEqual(
      state.applyBulletDamage(KNOT_SEGMENT_HP, { part: 'segment', index: segmentIndex }),
      { part: 'segment', index: segmentIndex },
    );
    assert.equal(state.segmentAlive(segmentIndex), false);
    assert.equal(state.applyBulletDamage(KNOT_SEGMENT_HP, { part: 'segment', index: segmentIndex }), null);
  });

  test('knot combat: damage without a position goes to the integrity', () => {
    const state = new KnotCombatState(shape);
    assert.equal(state.applyBulletDamage(1, null), null);
    assert.equal(state.integrity, state.maxIntegrity - 1);
    state.applyIntegrityDamage(state.maxIntegrity);
    assert.equal(state.integrity, 0);
    assert.equal(state.destroyed, true);
  });

  test('knot combat: losing the core destroys the enemy with integrity left', () => {
    const state = new KnotCombatState(shape);
    assert.deepEqual(state.applyBulletDamage(KNOT_CORE_HP, { part: 'core' }), { part: 'core' });
    assert.equal(state.coreHp, 0);
    assert.equal(state.destroyed, true);
    assert.equal(state.phase, 'collapsed');
    assert.ok(state.integrity > 0);
  });

  test('knot combat: the phase follows the severed fraction and shooter loss', () => {
    const state = new KnotCombatState(shape);
    assert.equal(state.phase, 'bound');
    const total = shape.segments.length;
    const sever = (count: number): void => {
      let done = 0;
      for (const segment of shape.segments) {
        if (done >= count) break;
        if (!state.segmentAlive(segment.index)) continue;
        state.applyBulletDamage(KNOT_SEGMENT_HP, { part: 'segment', index: segment.index });
        done += 1;
      }
    };
    sever(Math.ceil(total * 0.3));
    assert.equal(state.phase, 'loosening');
    sever(Math.ceil(total * 0.3));
    assert.equal(state.phase, 'unraveling');
    // 射撃ノードをすべて失えば、断裂が少なくても解体へ入る。
    const byShooters = new KnotCombatState(shape);
    for (const node of shape.nodes) {
      if (node.role === 'shooter') byShooters.applyBulletDamage(KNOT_NODE_HP, { part: 'node', index: node.index });
    }
    assert.equal(byShooters.shooterNodesAlive, false);
    assert.equal(byShooters.phase, 'unraveling');
  });

  test('knot combat: serialize and deserialize preserve the damage state', () => {
    const state = new KnotCombatState(shape);
    state.applyBulletDamage(KNOT_SEGMENT_HP, { part: 'segment', index: segmentIndex });
    state.applyBulletDamage(1, { part: 'core' });
    state.applyIntegrityDamage(2);
    const restored = KnotCombatState.deserialize(state.serialize(), shape);
    assert.deepEqual(restored.serialize(), state.serialize());
    assert.equal(restored.phase, state.phase);
    // 配列の数が合わない記録は、対応付けられないので無傷として組む。スカラーの
    // 中核 HP と耐久は記録どおりに通す。
    const mismatched = KnotCombatState.deserialize(
      { segmentHp: [0], nodeHp: [], coreHp: 0, integrity: 0 }, shape,
    );
    assert.equal(mismatched.segmentAlive(segmentIndex), true);
    assert.equal(mismatched.nodeAlive(shooterIndex), true);
    assert.equal(mismatched.coreHp, 0);
  });

  test('knot collision: spheres hit the strands and miss far away', () => {
    const collision = new KnotCollision(shape);
    const onStrand = shape.segments[0]!.midpoint;
    const hit = collision.testSphereCollision(
      v3(onStrand[0], onStrand[1], onStrand[2]), 1, ORIGIN, IDENTITY_Q,
    );
    assert.ok(hit !== null);
    const miss = collision.testSphereCollision(
      v3(shape.outerRadius * 3, 0, 0), 1, ORIGIN, IDENTITY_Q,
    );
    assert.equal(miss, null);
  });

  test('knot collision: targetAt attributes points to the nearest part', () => {
    const collision = new KnotCollision(shape);
    const node = shape.nodes[0]!;
    assert.deepEqual(
      collision.targetAt(v3(node.position[0], node.position[1], node.position[2])),
      { part: 'node', index: node.index },
    );
    assert.deepEqual(
      collision.targetAt(v3(shape.core.position[0], shape.core.position[1], shape.core.position[2])),
      { part: 'core' },
    );
    const segment = shape.segments[shape.segments.length - 1]!;
    assert.deepEqual(
      collision.targetAt(v3(segment.midpoint[0], segment.midpoint[1], segment.midpoint[2])),
      { part: 'segment', index: segment.index },
    );
  });

  test('knot collision: excluded parts leave the collision shape', () => {
    const collision = new KnotCollision(shape);
    for (const segment of shape.segments) collision.excludeSegment(segment.index);
    for (const node of shape.nodes) collision.excludeNode(node.index);
    // 索とノードをすべて外せば、中核の球だけが残る。
    const onStrand = shape.segments[0]!.midpoint;
    assert.equal(collision.testSphereCollision(
      v3(onStrand[0], onStrand[1], onStrand[2]), 1, ORIGIN, IDENTITY_Q,
    ), null);
    assert.ok(collision.testSphereCollision(
      v3(shape.core.position[0], shape.core.position[1], shape.core.position[2]), 1, ORIGIN, IDENTITY_Q,
    ) !== null);
    const target = collision.targetAt(v3(onStrand[0], onStrand[1], onStrand[2]));
    assert.ok(target === null || target.part !== 'segment');
  });

  test('knot enemy: serialize and deserialize preserve the individual and damage', () => {
    const idAllocators = new EntityIdAllocators();
    const enemy = KnotEnemy.create({
      name: 'knot-test',
      state: { t: 0, r: { x: 7e6, y: 0, z: 0 }, v: { x: 0, y: 7.5e3, z: 0 } },
      seed: 7, accent: 0xffffff, orbitLineColor: 0xffffff,
      formationId: null, formationRole: null,
    }, idAllocators, new THREE.Scene());
    assert.ok(enemy.hp > 0, '無傷の個体が初めから撃破扱いになっている');
    const serialized = enemy.serialize();
    assert.equal(serialized.kind, 'knot-enemy');
    assert.equal(isSerializedEnemy(serialized), true);
    assert.equal(findEntityClass('knot-enemy')?.kind, 'knot-enemy');
    assert.deepEqual(serialized.params, knotParamsFromSeed(7));
    const restored = KnotEnemy.deserialize(serialized, stubRegistry(idAllocators), new THREE.Scene());
    assert.deepEqual(restored.serialize().params, serialized.params);
    assert.deepEqual(restored.serialize().knot, serialized.knot);
    // 中核を失った記録は、耐久が残っていても撃破として復元される。
    const coreLost = KnotEnemy.deserialize(
      { ...serialized, knot: { ...serialized.knot, coreHp: 0 } },
      stubRegistry(idAllocators), new THREE.Scene(),
    );
    assert.equal(coreLost.hp, 0);
  });

  test('knot enemy: explicit params define the individual instead of the seed', () => {
    const idAllocators = new EntityIdAllocators();
    const params = { ...knotParamsFromSeed(3), family: 'lissajous' as const, strands: 1, fray: 0 };
    const enemy = KnotEnemy.create({
      name: 'knot-explicit',
      state: { t: 0, r: { x: 7e6, y: 0, z: 0 }, v: { x: 0, y: 7.5e3, z: 0 } },
      seed: 999, params, accent: 0xffffff, orbitLineColor: 0xffffff,
      formationId: null, formationRole: null,
    }, idAllocators, new THREE.Scene());
    assert.deepEqual(enemy.serialize().params, params);
  });

  test('knot enemy: the spawner generator places a drifting knot enemy', () => {
    const idAllocators = new EntityIdAllocators();
    const state = kinematicState<'eci'>(0, v3(7e6, 0, 0), v3(0, 7.5e3, 0));
    const enemy = generateKnotEnemy(
      'knot-spawn', state, 5, 0xffaa33, 0xffaa33, new THREE.Scene(), idAllocators,
    );
    assert.ok(enemy instanceof KnotEnemy);
    assert.equal(enemy.name, 'knot-spawn');
  });
}
