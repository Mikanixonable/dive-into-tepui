// セーブデータの索引が、手動セーブの件数の上限を守ることを検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { SaveSlots } from '../../src/launcher/save/save-slots';
import { MemorySaveStore } from './memory-save-store';
import { serializedGame } from './serialized-game';
import type { SnapshotMeta } from '../../src/launcher/save/slot-data';

// 手動セーブ id の、一覧に出すための要約。
function meta(id: string): SnapshotMeta {
  return {
    id,
    pinned: false,
    name: id,
    createdAtReal: 0,
    simTime: 0,
    centerBodyId: 'earth',
    altitude: 0,
    speed: 0,
    hpRatio: 1,
    maxHp: 100,
    magazines: 0,
    playerCount: 1,
    enemyAliveCount: 0,
    phase: 'playing',
  };
}

export function register(): void {
  test('save-slots: 手動セーブは同じステージ履歴で30件に達すると拒否し、既存の記録を消さない', () => {
    // SAVE.md「記録」: 同じステージ履歴の中で最大30件。上限を超えると拒否し、何かを消して空きを作ることはしない
    const store = new MemorySaveStore();
    const slots = SaveSlots.load(store);
    const slotId = slots.activeSlotId;
    assert.ok(slotId !== null);
    const data = serializedGame('stage00');
    const kept = Array.from({ length: 30 }, (_, i) => `manual-${i}`);
    for (const id of kept) assert.equal(slots.addManualSave(slotId, 'stage00', meta(id), data), true);

    assert.equal(slots.addManualSave(slotId, 'stage00', meta('manual-over'), data), false);
    const history = slots.activeSlot()?.stages.find((entry) => entry.stageId === 'stage00');
    assert.deepEqual(history?.snapshots.map((entry) => entry.id).sort(), [...kept].sort());
    for (const id of kept) assert.notEqual(store.readSnapshot(id), null);
    assert.equal(store.readSnapshot('manual-over'), null);

    // 上限はステージ履歴ごとに数える。
    assert.equal(slots.addManualSave(slotId, 'stage1', meta('other-stage'), data), true);
  });
}
