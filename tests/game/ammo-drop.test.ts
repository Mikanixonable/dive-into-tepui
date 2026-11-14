// 撃破で敵機の位置へ落ちる弾薬補給(撃破ドロップ)と、その回収・直列化の回帰テスト。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { len, scale, sub, v3 } from '../../src/math/vec3';
import { kinematicState, type KinematicState } from '../../src/physics/kinematic-state';
import { Stage, type GamePhase } from '../../src/game/stages/stage';
import { ScoreCounter } from '../../src/game/stages/stage-utils/score-counter';
import { Logistics } from '../../src/game/stages/stage-utils/logistics';
import { EntityIdAllocators } from '../../src/game/dynamic/dynamic-entity/entity-id';
import { AmmoPickup, isAmmoPickup, type SerializedAmmoPickup } from '../../src/game/dynamic/dynamic-entity/pickup';
import type { DynamicEntity } from '../../src/game/dynamic/dynamic-entity/dynamic-entity';
import type { EntityRegistry, SpawnRecord } from '../../src/game/dynamic/entity-registry';
import type { EntityRoster } from '../../src/game/dynamic/entity-roster';
import type { Enemy } from '../../src/game/dynamic/dynamic-entity/enemy';
import type { FormationRole } from '../../src/game/dynamic/dynamic-entity/entity-kind';
import type { ModularShip } from '../../src/game/ship/modular-ship';
import type { SimSpeedManager } from '../../src/game/dynamic/sim-speed-manager';
import type { RunEventBody } from '../../src/game/run-events';
import type { ShipBlueprintShelf } from '../../src/game/ship/ship-blueprint';

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
  blueprintShelf: ShipBlueprintShelf;
  grantedSalvageNames: Set<string>;
}

// playerState が null なら自機が居ない。居るときは、撃破記録が読む自機の運動状態だけを持つ面を差し込む。
function bareStage(
  system: TestDynamicSystem, playerState: KinematicState | null = null,
): { stage: Stage; logistics: Logistics } {
  const stage = Object.create(Stage.prototype) as Stage;
  const logistics = new Logistics(new THREE.Scene(), system, false);
  const fields = stage as unknown as BareStageFields;
  fields.scoreCounter = new ScoreCounter();
  fields.logistics = logistics;
  fields._phase = 'playing';
  fields._dynamicSystem = system;
  fields.blueprintShelf = { blueprints: [] };
  fields.grantedSalvageNames = new Set();
  // 自機は getter として差し込む。
  Object.defineProperty(stage, 'ship', {
    value: playerState === null ? null : { motion: { state: playerState, alive: true } },
  });
  return { stage, logistics };
}

// 撃破記録が読む面(表示名・最後の運動状態・陣形の役割)だけを持つ敵機の代役。
function enemyAt(state: KinematicState, formationRole: FormationRole | null = null): Enemy {
  return { name: '敵機', motion: { state }, formationRole } as unknown as Enemy;
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

  test('撃破ドロップ: 自機が居ないとき補給は敵機の速度を引き継ぎ小さな乱れで散る', () => {
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

  test('撃破ドロップ: 自機があるとき補給は自機から見た敵機の相対速度の 0.15 倍を残して飛ぶ', () => {
    const system = new TestDynamicSystem();
    const playerState = kinematicState<'eci'>(0, v3(7000e3, 0, 0), v3(0, 7600, 0));
    const enemyState = kinematicState<'eci'>(0, v3(7000e3 + 500, 0, 0), v3(300, 7600, 0));
    const { stage } = bareStage(system, playerState);

    stage.recordEnemyDeath(enemyAt(enemyState), 0, 'killed');

    const pickup = system.all().filter(isAmmoPickup)[0];
    assert.ok(pickup);
    // 乱れは成分ごとに ±1.5 m/s なので、残す量からのずれはその対角以内に収まる。
    const offset = sub(sub(pickup.motion.state.v, playerState.v), scale(sub(enemyState.v, playerState.v), 0.15));
    assert.ok(len(offset) <= 1.5 * Math.sqrt(3));
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
    logistics.dropAt(dropState, null, 6);

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

  test('撃破ドロップ: 落とした敵の陣形での役割でマガジン数が決まり、取り込むとその数が増える', () => {
    const cases: readonly (readonly [FormationRole | null, number])[] = [
      ['shield', 6], ['attacker', 4], ['energy', 4], [null, 2],
    ];
    for (const [role, mags] of cases) {
      const system = new TestDynamicSystem();
      const { stage, logistics } = bareStage(system);
      const enemyState = kinematicState<'eci'>(0, v3(7000e3, 0, 0), v3(0, 7500, 0));
      stage.recordEnemyDeath(enemyAt(enemyState, role), 0, 'killed');
      assert.equal(system.all().filter(isAmmoPickup)[0]?.mags, mags);

      let pickedMags = 0;
      const player = {
        motion: { state: kinematicState<'eci'>(0, v3(7000e3, 0, 0), v3(0, 7500, 0)) },
        onPickup: (picked: number): void => { pickedMags += picked; },
      } as unknown as ModularShip;
      logistics.updateLogistics(0, player, { canResupplyAmmo: false } as unknown as SimSpeedManager);
      assert.equal(pickedMags, mags);
    }
  });

  test('補給の直列化はマガジン数を保ち、記録に無ければ 6 で読む', () => {
    const system = new TestDynamicSystem();
    const scene = new THREE.Scene();
    const state = kinematicState<'eci'>(0, v3(7000e3, 0, 0), v3(0, 7500, 0));
    const pickup = AmmoPickup.create({ state }, scene, system.idAllocators, 4);
    assert.equal(AmmoPickup.deserialize(pickup.serialize(), system, scene).mags, 4);

    // マガジン数の項目が無い旧い記録は、既定の 6 で読む。
    const legacy = { ...pickup.serialize(), mags: undefined } as SerializedAmmoPickup;
    assert.equal(AmmoPickup.deserialize(legacy, system, scene).mags, 6);
  });
}
