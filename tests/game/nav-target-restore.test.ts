// 航法ターゲットの復元が、撃墜された対象を外し、消えない対象と生きている対象を戻すことを検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { Q_IDENTITY } from '../../src/math/quat';
import { v3 } from '../../src/math/vec3';
import { kinematicState } from '../../src/physics/kinematic-state';
import { lagrangeId } from '../../src/game/celestial/lagrange-id';
import { EntityIdAllocators } from '../../src/game/dynamic/dynamic-entity/entity-id';
import { MetalEnemy } from '../../src/game/dynamic/dynamic-entity/metal-enemy';
import { RunEventLog } from '../../src/game/run-events';
import { NavTargetSelection } from '../../src/game/viewer/nav-target-selection';
import type { EntityRegistry } from '../../src/game/dynamic/entity-registry';
import type { EntityRoster } from '../../src/game/dynamic/entity-roster';

// 金属敵 name を1体、新しく置く。
function newEnemy(name: string, idAllocators: EntityIdAllocators): MetalEnemy {
  return MetalEnemy.create({
    name,
    state: kinematicState<'eci'>(0, v3(7e6, 0, 0), v3(0, 7.5e3, 0)),
    q: Q_IDENTITY,
    w: v3(),
    accent: 0xffffff,
    orbitLineColor: 0xffffff,
    typeIndex: null,
  }, idAllocators);
}

// 読み込んだ直後の顔ぶれ。撃墜されたまま記録された敵 wreck と、生きている敵 survivor を持つ。
function restoredRoster(): { roster: EntityRoster; wreck: MetalEnemy; survivor: MetalEnemy } {
  const idAllocators = new EntityIdAllocators();
  const registry: EntityRegistry = {
    idAllocators,
    events: new RunEventLog(),
    add: () => {},
    spawnWhenReady: () => {},
    pendingEnemyCount: 0,
  };
  const wreck = MetalEnemy.deserialize({ ...newEnemy('wreck', idAllocators).serialize(), alive: false }, registry);
  const survivor = newEnemy('survivor', idAllocators);
  return { roster: { all: () => [wreck, survivor], collectionRevision: 0, simTime: 0 }, wreck, survivor };
}

export function register(): void {
  test('nav-target-restore: 撃墜された敵を指していた記録からは、ターゲット未選択で戻る', () => {
    // SAVE.md「保存される内容」: 読み込み時に対象がもう存在しない(撃墜・破壊された)場合は、ターゲット未選択に戻る
    const { roster, wreck } = restoredRoster();
    const selection = NavTargetSelection.deserialize({ id: wreck.id, name: wreck.name }, roster, new RunEventLog());
    assert.equal(selection.id, null);
    assert.equal(selection.name, null);
  });

  test('nav-target-restore: 生きている敵を指していた記録からは、同じ敵をターゲットにして戻る', () => {
    // SAVE.md「保存される内容」: いまターゲットに設定している対象は保存される
    const { roster, survivor } = restoredRoster();
    const selection = NavTargetSelection.deserialize(
      { id: survivor.id, name: survivor.name }, roster, new RunEventLog(),
    );
    assert.equal(selection.id, survivor.id);
    assert.equal(selection.name, survivor.name);
  });

  test('nav-target-restore: 天体とラグランジュ点を指していた記録は、顔ぶれによらず戻る', () => {
    // SAVE.md「保存される内容」: 天体・ラグランジュ点など消滅しない対象は常に復元される
    const { roster } = restoredRoster();
    for (const id of ['moon', lagrangeId('moon', 1)]) {
      const selection = NavTargetSelection.deserialize({ id, name: id }, roster, new RunEventLog());
      assert.equal(selection.id, id);
    }
  });
}
