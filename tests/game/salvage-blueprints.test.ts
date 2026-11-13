// 鹵獲の設計図: 撃破数の節目の跨ぎで授与が記録され、棚の同名を除き、残り撃破数を導くことを検査する。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { v3 } from '../../src/math/vec3';
import { kinematicState, type KinematicState } from '../../src/physics/kinematic-state';
import { Stage, type GamePhase } from '../../src/game/stages/stage';
import { CreativeStage } from '../../src/game/stages/creative-stage';
import { ScoreCounter } from '../../src/game/stages/stage-utils/score-counter';
import { Logistics } from '../../src/game/stages/stage-utils/logistics';
import { EntityIdAllocators } from '../../src/game/dynamic/dynamic-entity/entity-id';
import {
  SALVAGE_BLUEPRINTS, appendSalvageCargo, crossedSalvageBlueprints, nextSalvageRemaining,
} from '../../src/game/ship/salvage-blueprints';
import { ShipAssembly } from '../../src/game/ship/ship-assembly';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import { createShipModuleInstance } from '../../src/game/ship/ship-module-instance';
import { isShipBlueprint, type ShipBlueprintShelf } from '../../src/game/ship/ship-blueprint';
import type { DynamicEntity } from '../../src/game/dynamic/dynamic-entity/dynamic-entity';
import type { EntityRegistry, SpawnRecord } from '../../src/game/dynamic/entity-registry';
import type { EntityRoster } from '../../src/game/dynamic/entity-roster';
import type { Enemy } from '../../src/game/dynamic/dynamic-entity/enemy';
import type { RunEventBody } from '../../src/game/run-events';

// エンティティを配列へ積み、出来事を集める台帳の最小の代役。
class TestDynamicSystem implements EntityRegistry, EntityRoster {
  public readonly idAllocators = new EntityIdAllocators();
  public readonly bodies: RunEventBody[] = [];
  public readonly events = { record: (body: RunEventBody): void => { this.bodies.push(body); } };
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

// 空の棚。blueprints で差し替えて同名を置けるようにする。
function shelf(blueprints: ShipBlueprintShelf['blueprints'] = []): ShipBlueprintShelf {
  return { blueprints };
}

// Stage はコンストラクタで DOM を要する状況パネルを組むので、node では撃破記録が読む欄だけを
// 差し込んだ骨組みを作る。stageRules は prototype に応じてそのクラスの宣言を引く。
interface BareStageFields {
  scoreCounter: ScoreCounter;
  logistics: Logistics;
  _phase: GamePhase;
  _dynamicSystem: EntityRegistry & EntityRoster;
  blueprintShelf: ShipBlueprintShelf;
  grantedSalvageNames: Set<string>;
}

function bareStage(
  prototype: object, system: TestDynamicSystem, kills: number, blueprintShelf: ShipBlueprintShelf,
): Stage {
  const stage = Object.create(prototype) as Stage;
  const fields = stage as unknown as BareStageFields;
  fields.scoreCounter = new ScoreCounter(0, 0, kills);
  fields.logistics = new Logistics(new THREE.Scene(), system, false);
  fields._phase = 'playing';
  fields._dynamicSystem = system;
  fields.blueprintShelf = blueprintShelf;
  fields.grantedSalvageNames = new Set();
  // 撃破記録は撃破ドロップの速度に自機を読むので、自機の居ない骨組みとして差し込む。
  Object.defineProperty(stage, 'ship', { value: null });
  return stage;
}

// 撃破記録が読む面(表示名と最後の運動状態)だけを持つ敵機の代役。
function enemyAt(state: KinematicState): Enemy {
  return { name: '敵機', motion: { state } } as unknown as Enemy;
}

const ENEMY_STATE = kinematicState<'eci'>(0, v3(7000e3, 0, 0), v3(0, 7500, 0));

function grantedNames(system: TestDynamicSystem): readonly string[] {
  return system.bodies
    .filter((body) => body.kind === 'salvageBlueprintGranted')
    .map((body) => (body as { name: string }).name);
}

export function register(): void {
  test('鹵獲: 撃破数が節目 3・10・25 を跨ぐと、それぞれの設計図の授与が記録される', () => {
    const cases: readonly [number, string][] = [
      [3, '鹵獲: 砲座'], [10, '鹵獲: 物資ポッド'], [25, '鹵獲: 強襲艇'],
    ];
    for (const [milestone, name] of cases) {
      const system = new TestDynamicSystem();
      const stage = bareStage(Stage.prototype, system, milestone - 1, shelf());
      stage.recordEnemyDeath(enemyAt(ENEMY_STATE), 0, 'killed');
      assert.deepEqual(grantedNames(system), [name], `節目 ${milestone}`);
    }
  });

  test('鹵獲: 1撃破で複数の節目を跨いだら全部の授与が出る', () => {
    const grants = crossedSalvageBlueprints(0, 26, new Set(), shelf());
    assert.deepEqual(grants.map((grant) => grant.name), ['鹵獲: 砲座', '鹵獲: 物資ポッド', '鹵獲: 強襲艇']);
  });

  test('鹵獲: 節目の設計図が棚に同名であるとき授与は記録されない', () => {
    const blueprint = { id: 'salvage-gunpod', name: '鹵獲: 砲座', createdAtReal: 0, piece: SALVAGE_BLUEPRINTS[0]!.piece };
    const system = new TestDynamicSystem();
    const stage = bareStage(Stage.prototype, system, 2, shelf([blueprint]));
    stage.recordEnemyDeath(enemyAt(ENEMY_STATE), 0, 'killed');
    assert.deepEqual(grantedNames(system), []);
  });

  test('鹵獲: 授与済みの設計図は同じランで二度記録されない', () => {
    const system = new TestDynamicSystem();
    // 撃破数が既に節目を過ぎた途中からのランでも、跨いだ分だけ記録される。
    const stage = bareStage(Stage.prototype, system, 2, shelf());
    stage.recordEnemyDeath(enemyAt(ENEMY_STATE), 0, 'killed');
    assert.deepEqual(grantedNames(system), ['鹵獲: 砲座']);
    stage.recordEnemyDeath(enemyAt(ENEMY_STATE), 0, 'killed');
    assert.deepEqual(grantedNames(system), ['鹵獲: 砲座']);
  });

  test('鹵獲: salvageRewards を数えないステージでは授与が記録されない', () => {
    const system = new TestDynamicSystem();
    const stage = bareStage(CreativeStage.prototype, system, 2, shelf());
    stage.recordEnemyDeath(enemyAt(ENEMY_STATE), 0, 'killed');
    assert.deepEqual(grantedNames(system), []);
  });

  test('鹵獲: 3つの設計図定義はカタログの既知モジュールだけで復元できる接続木を持つ', () => {
    for (const entry of SALVAGE_BLUEPRINTS) {
      const blueprint = { id: entry.id, name: entry.name, createdAtReal: 0, piece: entry.piece };
      assert.equal(isShipBlueprint(blueprint), true, entry.name);
    }
    assert.deepEqual(SALVAGE_BLUEPRINTS.map((entry) => entry.kills), [3, 10, 25]);
  });

  test('鹵獲: 次の未授与の節目までの残り撃破数を導く', () => {
    // どの節目も授与前なら、いちばん近い節目までの差を返す。
    assert.equal(nextSalvageRemaining(0, new Set(), shelf()), 3);
    assert.equal(nextSalvageRemaining(2, new Set(), shelf()), 1);
    assert.equal(nextSalvageRemaining(4, new Set(['鹵獲: 砲座']), shelf()), 6);
    // 棚に同名がある節目は授与済みとして飛ばす。
    const owned = [{ id: 'x', name: '鹵獲: 砲座', createdAtReal: 0, piece: SALVAGE_BLUEPRINTS[0]!.piece }];
    assert.equal(nextSalvageRemaining(2, new Set(), shelf(owned)), 8);
    // 残る節目がすべて授与済みなら出さない。
    assert.equal(nextSalvageRemaining(4, new Set(['鹵獲: 砲座', '鹵獲: 物資ポッド', '鹵獲: 強襲艇']), shelf()), null);
    // 節目を過ぎた分は残数として出さない。
    assert.equal(nextSalvageRemaining(26, new Set(), shelf()), null);
  });

  test('鹵獲: 同じ船体へ鹵獲品を二度連ねても識別子が衝突せず、組み立ては妥当なまま', () => {
    const assembly = new ShipAssembly(SHIP_MODULE_CATALOG, true);
    assembly.addRoot(createShipModuleInstance(SHIP_MODULE_CATALOG.require('tank-combat-main'), 'tank'));
    const first = appendSalvageCargo(assembly, 'supply-pod', 'tank', 'a-');
    appendSalvageCargo(assembly, 'assault-craft', first, 'b-');

    const ids = assembly.modules.map(module => module.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.doesNotThrow(() => assembly.assertValid());
  });
}
