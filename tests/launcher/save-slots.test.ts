// セーブデータの索引が、手動セーブの件数の上限を守り、設計図をスロットの操作へ連れていくことを検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { SaveSlots } from '../../src/launcher/save/save-slots';
import { checkSlotExportShape } from '../../src/launcher/save/save-transfer';
import { MemorySaveStore } from './memory-save-store';
import { serializedGame } from './serialized-game';
import { blueprint } from './blueprint';
import type { ShipBlueprint } from '../../src/game/ship/ship-blueprint';
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

  test('save-slots: 複製と「ここから分岐」は設計図の一覧も持っていく', () => {
    // SAVE.md「設計図」: セーブデータの複製・「ここから分岐」・書き出しは、設計図の一覧も持っていく
    const store = new MemorySaveStore();
    const slots = SaveSlots.load(store);
    const slotId = slots.activeSlotId;
    assert.ok(slotId !== null);
    assert.equal(slots.addManualSave(slotId, 'stage00', meta('snap-1'), serializedGame('stage00')), true);
    assert.equal(slots.writeBlueprints(slotId, [blueprint('bp-1'), blueprint('bp-2')]), true);

    const copy = slots.duplicateSlot(slotId);
    assert.ok(copy !== null);
    assert.deepEqual(slots.blueprints(copy.id).map((b) => b.id), ['bp-1', 'bp-2']);

    const branch = slots.duplicateSlot(slotId, 'snap-1');
    assert.ok(branch !== null);
    assert.deepEqual(slots.blueprints(branch.id).map((b) => b.id), ['bp-1', 'bp-2']);
  });

  test('save-slots: 設計図はスロットの削除で消え、別スロットからは見えない', () => {
    // SAVE.md「設計図」: 別のセーブデータからは見えない。セーブデータを削除すると、その設計図も消える
    const store = new MemorySaveStore();
    const slots = SaveSlots.load(store);
    const first = slots.activeSlotId;
    assert.ok(first !== null);
    const second = slots.createSlot('別のセーブデータ');
    assert.equal(slots.writeBlueprints(first, [blueprint('bp-1')]), true);

    assert.equal(slots.blueprints(second.id).length, 0);

    slots.deleteSlot(first);
    assert.deepEqual(store.readBlueprints(first), []);
  });

  test('save-slots: 書き出し→取り込みで設計図が戻り、壊れた設計図だけ除外される', () => {
    // SAVE.md「設計図」: 読み込んだファイルの設計図のうち壊れているものは個別に除外し、
    // それだけで読み込み全体を失敗させない
    const store = new MemorySaveStore();
    const slots = SaveSlots.load(store);
    const slotId = slots.activeSlotId;
    assert.ok(slotId !== null);
    assert.equal(slots.addManualSave(slotId, 'stage00', meta('snap-1'), serializedGame('stage00')), true);
    assert.equal(slots.writeBlueprints(slotId, [blueprint('bp-1'), blueprint('bp-2')]), true);

    // 書き出しへ、復元できない先端部を載せた設計図と設計図でない値を混ぜる。
    const exported = slots.exportSlot(slotId);
    assert.ok(exported !== null);
    const broken: ShipBlueprint = {
      id: 'bp-broken',
      name: '壊れた設計図',
      createdAtReal: 0,
      piece: { playerOwned: true, modules: [], connections: [] },
    };
    const checked = checkSlotExportShape({
      ...exported,
      blueprints: [...(exported.blueprints ?? []), broken, '設計図でない値'],
    });
    if (!checked.ok) assert.fail(checked.reason);
    assert.deepEqual(checked.exp.blueprints?.map((b) => b.id), ['bp-1', 'bp-2']);

    const imported = slots.importSlot(checked.exp);
    assert.ok(imported !== null);
    assert.deepEqual(slots.blueprints(imported.id).map((b) => b.id), ['bp-1', 'bp-2']);
  });
}
