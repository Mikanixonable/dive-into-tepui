// 実体ごとの表示設定が直列化した記録から戻り、切り替えが往復することを固定する(R4)。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { EntityDisplaySelection } from '../../src/game/viewer/entity-display-selection';

// 実体ごとの表示設定の規則を登録する。
export function register(): void {
  test('entity-display-selection: 記録にある id だけ線を出す', () => {
    const selection = EntityDisplaySelection.deserialize({
      trajectoryLineIds: ['entity-0', 'base-0'],
    });

    assert.equal(selection.showsTrajectoryLine('entity-0'), true);
    assert.equal(selection.showsTrajectoryLine('base-0'), true);
    assert.equal(selection.showsTrajectoryLine('entity-1'), false);
    assert.equal(new EntityDisplaySelection().showsTrajectoryLine('entity-0'), false);
  });

  test('entity-display-selection: 直列化と復元で線の表示が往復する', () => {
    const selection = new EntityDisplaySelection();
    selection.toggleTrajectoryLine('entity-3');

    const restored = EntityDisplaySelection.deserialize(JSON.parse(JSON.stringify(selection.serialize())));
    assert.deepEqual(restored.serialize(), selection.serialize());
    assert.equal(restored.showsTrajectoryLine('entity-3'), true);
  });

  test('entity-display-selection: 旧い記録に残る廃止済みの項目は読み飛ばす', () => {
    const legacy = JSON.parse(JSON.stringify({
      trajectoryLineIds: ['entity-9'],
      proteinDisplay: { representation: 'silhouette', colorMode: 'hydrophobicity' },
    }));
    const selection = EntityDisplaySelection.deserialize(legacy);
    assert.equal(selection.showsTrajectoryLine('entity-9'), true);
    assert.deepEqual(selection.serialize(), { trajectoryLineIds: ['entity-9'] });
  });

  test('entity-display-selection: toggleTrajectoryLine は出す・消すを往復する', () => {
    const selection = EntityDisplaySelection.deserialize({
      trajectoryLineIds: ['entity-0'],
    });

    selection.toggleTrajectoryLine('entity-1');
    assert.equal(selection.showsTrajectoryLine('entity-1'), true);
    selection.toggleTrajectoryLine('entity-1');
    assert.equal(selection.showsTrajectoryLine('entity-1'), false);
    selection.toggleTrajectoryLine('entity-0');
    assert.equal(selection.showsTrajectoryLine('entity-0'), false);
    selection.toggleTrajectoryLine('entity-0');
    assert.equal(selection.showsTrajectoryLine('entity-0'), true);
  });
}
