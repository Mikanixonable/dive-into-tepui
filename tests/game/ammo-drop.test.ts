import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { len, sub, v3 } from '../../src/math/vec3';
import { kinematicState, type KinematicState } from '../../src/physics/kinematic-state';
import { Stage, type GamePhase } from '../../src/game/stages/stage';
import { ScoreCounter } from '../../src/game/stages/stage-utils/score-counter';
import { Logistics } from '../../src/game/stages/stage-utils/logistics';
import { EntityIdAllocators } from '../../src/game/dynamic/dynamic-entity/entity-id';
import { isAmmoPickup } from '../../src/game/dynamic/dynamic-entity/pickup';
import type { DynamicEntity } from '../../src/game/dynamic/dynamic-entity/dynamic-entity';
import type { EntityRegistry, SpawnRecord } from '../../src/game/dynamic/entity-registry';
import type { EntityRoster } from '../../src/game/dynamic/entity-roster';
import type { Enemy } from '../../src/game/dynamic/dynamic-entity/enemy';
import type { ModularShip } from '../../src/game/ship/modular-ship';
import type { SimSpeedManager } from '../../src/game/dynamic/sim-speed-manager';
import type { RunEventBody } from '../../src/game/run-events';

// エンティティを配列へ積むだけの、補給と撃破記録が受け取る台帳の最小の代役。
class TestDynamicSystem implements EntityRegistry, EntityRoster {
  public readonly idAllocators = new EntityIdAllocators();
  public readonly events = { record: (_body: RunEventBody): void => {} };
  public readonly pendingEnemyCount = 0;
  public readonly collectionRevision = 0;
  public readonly simTime = 0;
  private readonly entities: DynamicEntity[] = [];

  public add(entity: DynamicEntity): void {
    this.entities.push(entity);
  }

  public spawnWhenReady(_record: SpawnRecord): void {}

  public all(): readonly DynamicEntity[] {
    return this.entities;
  }
}

// Stage はコンストラクタで DOM を要する状況パネルを組むので、node では撃破記録が読む欄だけを
// 差し込んだ骨組みを作り、死因による分岐を試す。
interface BareStageFields {
  scoreCounter: ScoreCounter;
  logistics: Logistics;
  _phase: GamePhase;
  _dynamicSystem: EntityRegistry & EntityRoster;
}

function bareStage(system: TestDynamicSystem): { stage: Stage; logistics: Logistics } {
  const stage = Object.create(Stage.prototype) as Stage;
  const logistics = new Logistics(new THREE.Scene(), system, false);
  const fields = stage as unknown as BareStageFields;
  fields.scoreCounter = new ScoreCounter();
  fields.logistics = logistics;
  fields._phase = 'playing';
  fields._dynamicSystem = system;
  return { stage, logistics };
}

// 撃破記録が読む面(表示名と最後の運動状態)だけを持つ敵機の代役。
function enemyAt(state: KinematicState): Enemy {
  return { name: '敵機', motion: { state } } as unknown as Enemy;
}

export function register(): void {
  test('撃破ドロップ: 撃破で敵機の位置へ弾薬補給が1個出る', () => {
    const system = new TestDynamicSystem();
    const { stage } = bareStage(system);
    const enemyState = kinematicState<'eci'>(0, v3(7000e3, 100, -200), v3(50, 7500, -30));

    stage.recordEnemyDeath(enemyAt(enemyState), 0, 'killed');

    const pickups = system.all().filter(isAmmoPickup);
    assert.equal(pickups.length, 1);
    assert.equal(pickups[0]?.motion.state.t, enemyState.t);
    assert.deepEqual(pickups[0]?.motion.state.r, enemyState.r);
  });

  test('撃破ドロップ: 補給は敵機の速度を引き継ぎ小さな乱れで散る', () => {
    const system = new TestDynamicSystem();
    const { stage } = bareStage(system);
    const enemyState = kinematicState<'eci'>(0, v3(7000e3, 0, 0), v3(50, 7500, -30));

    stage.recordEnemyDeath(enemyAt(enemyState), 0, 'killed');

    const pickup = system.all().filter(isAmmoPickup)[0];
    assert.ok(pickup);
    const dv = sub(pickup.motion.state.v, enemyState.v);
    assert.ok(Math.abs(dv.x) <= 1.5);
    assert.ok(Math.abs(dv.y) <= 1.5);
    assert.ok(Math.abs(dv.z) <= 1.5);
    assert.ok(len(dv) <= 1.5 * Math.sqrt(3));
  });

  test('撃破ドロップ: 焼失・衝突・離脱では補給が出ない', () => {
    const system = new TestDynamicSystem();
    const { stage } = bareStage(system);
    const enemyState = kinematicState<'eci'>(0, v3(7000e3, 0, 0), v3(0, 7500, 0));

    for (const cause of ['burnup', 'collision', 'despawn'] as const) {
      stage.recordEnemyDeath(enemyAt(enemyState), 0, cause);
    }

    assert.equal(system.all().filter(isAmmoPickup).length, 0);
  });

  test('撃破ドロップ: 出た補給は通常の回収判定で拾える', () => {
    const system = new TestDynamicSystem();
    const { logistics } = bareStage(system);
    const dropState = kinematicState<'eci'>(0, v3(7000e3, 0, 0), v3(0, 7500, 0));
    logistics.dropAt(dropState);

    let pickedMags = 0;
    const player = {
      motion: { state: kinematicState<'eci'>(0, v3(7000e3 + 10, 0, 0), v3(0, 7500, 0)) },
      onPickup: (mags: number): void => { pickedMags += mags; },
    } as unknown as ModularShip;
    const simSpeed = { canResupplyAmmo: false } as unknown as SimSpeedManager;

    logistics.updateLogistics(0, player, simSpeed);

    const pickups = system.all().filter(isAmmoPickup);
    assert.equal(pickups.length, 1);
    assert.equal(pickups[0]?.motion.alive, false);
    assert.equal(pickedMags, 6);
  });
}
