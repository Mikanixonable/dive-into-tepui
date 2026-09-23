import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { v3 } from '../../src/math/vec3';
import { kinematicState } from '../../src/physics/kinematic-state';
import { DynamicMotion } from '../../src/game/dynamic/dynamic-motion';
import {
  EnemyFireController, EnemyFireState,
  type EnemyFireControllerPort,
} from '../../src/game/dynamic/dynamic-entity/enemy-fire-controller';
import { EntityIdAllocators } from '../../src/game/dynamic/dynamic-entity/entity-id';
import type { EntityRegistry } from '../../src/game/dynamic/entity-registry';
import { RunEventLog } from '../../src/game/run-events';
import type { ModularShip } from '../../src/game/ship/modular-ship';
import type { CelestialBodies } from '../../src/game/celestial/celestial-bodies';
import { MetalEnemy } from '../../src/game/dynamic/dynamic-entity/metal-enemy';

interface FireHarness {
  readonly controller: EnemyFireController;
  readonly state: EnemyFireState;
  readonly player: ModularShip;
  readonly registry: EntityRegistry;
  readonly bodies: CelestialBodies;
  readonly shots: () => number;
}

function fireHarness(
  state: EnemyFireState,
  canFire = true,
  playerX = 1000,
): FireHarness {
  const motion = new DynamicMotion(kinematicState<'eci'>(0, v3(), v3()));
  const playerMotion = new DynamicMotion(kinematicState<'eci'>(0, v3(playerX, 0, 0), v3()));
  let shotCount = 0;
  const port: EnemyFireControllerPort = {
    motion,
    attackGroupId: 'test-group',
    canFire: () => canFire,
    muzzlePosition: () => motion.state.r,
    plasmaDamage: () => 1,
    fired: () => { shotCount++; },
  };
  const registry: EntityRegistry = {
    idAllocators: new EntityIdAllocators(),
    events: new RunEventLog(),
    add: () => {},
    spawnWhenReady: () => {},
    pendingEnemyCount: 0,
  };
  return {
    controller: new EnemyFireController(port, state),
    state,
    player: { motion: playerMotion } as unknown as ModularShip,
    registry,
    bodies: { starId: null } as CelestialBodies,
    shots: () => shotCount,
  };
}

function update(harness: FireHarness, simTime: number, mayFire = true): void {
  harness.controller.updateBehavior(
    simTime, harness.player, harness.registry, [], mayFire, harness.bodies,
  );
}

export function register(): void {
  test('enemy fire: coarse and fine behavior updates preserve the same due burst shots', () => {
    const coarse = fireHarness(new EnemyFireState(3, 0.05, null, 0));
    update(coarse, 0.22);

    const fine = fireHarness(new EnemyFireState(3, 0.05, null, 0));
    update(fine, 0.06);
    update(fine, 0.14);
    update(fine, 0.22);

    assert.equal(coarse.shots(), 3);
    assert.equal(fine.shots(), coarse.shots());
    const coarseState = coarse.state.serialize();
    const fineState = fine.state.serialize();
    assert.equal(coarseState.burstLeft, fineState.burstLeft);
    assert.ok(Math.abs((coarseState.burstDelay ?? 0) - (fineState.burstDelay ?? 0)) < 1e-12);
  });

  test('enemy fire: mayFire false pauses an in-progress burst instead of consuming its delay', () => {
    const harness = fireHarness(new EnemyFireState(1, 0.05, null, 0));
    update(harness, 1, false);
    update(harness, 1.04);
    assert.equal(harness.shots(), 0);
    update(harness, 1.051);
    assert.equal(harness.shots(), 1);
  });

  test('enemy fire: leaving engagement range pauses an in-progress burst', () => {
    const harness = fireHarness(new EnemyFireState(1, 0.05, null, 0), true, 100_000);
    update(harness, 1);
    harness.player.motion.reset(kinematicState<'eci'>(1, v3(1000, 0, 0), v3()));
    update(harness, 1.04);
    assert.equal(harness.shots(), 0);
    update(harness, 1.051);
    assert.equal(harness.shots(), 1);
  });

  test('enemy fire: an individual canFire failure cancels the in-progress burst', () => {
    const harness = fireHarness(new EnemyFireState(3, 0.05, null, 0), false);
    update(harness, 0.01);
    assert.equal(harness.state.serialize().burstLeft, null);
    assert.equal(harness.state.serialize().burstDelay, null);
  });

  test('metal enemy: default max HP is the generated part HP sum', () => {
    const idAllocators = new EntityIdAllocators();
    const enemy = MetalEnemy.create({
      name: 'metal-test',
      state: kinematicState<'eci'>(0, v3(7e6, 0, 0), v3(0, 7500, 0)),
      q: { x: 0, y: 0, z: 0, w: 1 },
      w: v3(),
      accent: 0xffffff,
      orbitLineColor: 0xffffff,
      waveId: null,
      formationId: null,
      formationRole: null,
      typeIndex: null,
    }, idAllocators);
    const partMaxHp = enemy.parts.reduce((sum, part) => sum + part.maxHp, 0);
    assert.equal(enemy.maxHp, partMaxHp);
    assert.equal(enemy.maxHp, 11);
    enemy.dispose();
  });
}
