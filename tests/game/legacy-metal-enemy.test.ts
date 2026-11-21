// 組み立て型へ統一する前のセーブにいる金属の敵機が、読み込み時に組み立て型へ置き換わることを検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { findEntityClass, isSerializedEnemy } from '../../src/game/dynamic/entity/entity-dictionary';
import { AssemblyEnemy } from '../../src/game/dynamic/entity/assembly-enemy';
import { EntityIdAllocators } from '../../src/game/dynamic/entity/entity-id';
import type { SerializedLegacyMetalEnemy } from '../../src/game/dynamic/entity/legacy-metal-enemy';
import { RunEventLog } from '../../src/game/run-events';
import type { EntityRegistry } from '../../src/game/dynamic/entity-registry';

// 旧セーブの金属の敵機1体ぶんの記録。型番と部品の記録は、読み込みでは使われない。
function legacyRecord(alive: boolean): SerializedLegacyMetalEnemy {
  return {
    kind: 'metal-enemy', id: 'legacy-1', name: 'W3-2',
    t: 12, r: { x: 7e6, y: 1, z: 2 }, v: { x: 3, y: 7.5e3, z: 4 },
    q: { x: 0, y: 0, z: 0, w: 1 }, w: { x: 0.01, y: 0.02, z: 0.03 },
    alive,
    thermal: { temperature: 300 } as SerializedLegacyMetalEnemy['thermal'],
    accent: 0x3dc6ff, orbitLineColor: 0x3dc6ff,
    attackGroupId: 'wave-3-group-1', waveId: 3, formationId: null, formationRole: null,
    fireController: { burstLeft: 2, burstDelay: 0.5, lastFireSim: 10, lastBehaviorSim: 11 },
    typeIndex: 1, parts: [],
  } as unknown as SerializedLegacyMetalEnemy;
}

function registry(): EntityRegistry {
  return {
    idAllocators: new EntityIdAllocators(), events: new RunEventLog(),
    add: () => {}, spawnWhenReady: () => {}, pendingEnemyCount: 0,
  };
}

export function register(): void {
  test('legacy-metal-enemy: 旧セーブの金属の敵機は、所属と生死を保って組み立て型になる', () => {
    // SAVE.md「保存される内容」: 金属の敵機は読み込み時に新しい組み立て型の個体へ置き換わる
    const record = legacyRecord(true);
    const entityClass = findEntityClass(record.kind);
    assert.ok(entityClass !== null);
    assert.ok(isSerializedEnemy(record));
    const enemy = entityClass.deserialize(record, registry(), undefined as never);
    assert.ok(enemy instanceof AssemblyEnemy);
    const out = enemy.serialize();
    assert.equal(out.kind, 'assembly-enemy');
    assert.equal(out.name, 'W3-2');
    assert.equal(out.attackGroupId, 'wave-3-group-1');
    assert.equal(out.waveId, 3);
    assert.equal(out.accent, 0x3dc6ff);
    assert.deepEqual(out.r, record.r);
    assert.deepEqual(out.v, record.v);
    assert.deepEqual(out.w, record.w);
    assert.equal(out.alive, true);
    assert.equal(enemy.hp, enemy.maxHp);
  });

  test('legacy-metal-enemy: 撃墜済みの記録は撃墜済みのまま変換される', () => {
    const record = legacyRecord(false);
    const enemy = findEntityClass(record.kind)!.deserialize(record, registry(), undefined as never);
    assert.equal(enemy.serialize().alive, false);
  });
}
