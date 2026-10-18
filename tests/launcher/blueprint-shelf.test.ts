// 設計図の棚が、アクティブなセーブデータの一覧を読み、記録をセーブデータへ残すことを検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { SaveSlots } from '../../src/launcher/save/save-slots';
import { BlueprintShelf } from '../../src/launcher/save/blueprint-shelf';
import { MemorySaveStore } from './memory-save-store';
import { blueprint } from './blueprint';

export function register(): void {
  test('blueprint-shelf: 追加・改名・削除は一覧とセーブデータの両方へ残る', () => {
    // SAVE.md「設計図」: 設計図を保存・改名・削除すると、その場でセーブデータへ記録される
    const store = new MemorySaveStore();
    const slots = SaveSlots.load(store);
    const slotId = slots.activeSlotId;
    assert.ok(slotId !== null);
    const shelf = new BlueprintShelf(slots);
    assert.equal(shelf.canRecord, true);

    assert.equal(shelf.add(blueprint('bp-1')), true);
    assert.equal(shelf.add(blueprint('bp-2')), true);
    assert.deepEqual(shelf.blueprints.map((b) => b.id), ['bp-2', 'bp-1']);
    assert.deepEqual(slots.blueprints(slotId).map((b) => b.id), ['bp-2', 'bp-1']);

    assert.equal(shelf.rename('bp-1', '新しい名前'), true);
    assert.equal(shelf.blueprints.find((b) => b.id === 'bp-1')?.name, '新しい名前');
    assert.equal(slots.blueprints(slotId).find((b) => b.id === 'bp-1')?.name, '新しい名前');

    assert.equal(shelf.delete('bp-2'), true);
    assert.deepEqual(shelf.blueprints.map((b) => b.id), ['bp-1']);
    assert.deepEqual(slots.blueprints(slotId).map((b) => b.id), ['bp-1']);
  });

  test('blueprint-shelf: セーブデータの切り替えは reload で追い、アクティブなセーブデータが無ければ記録できない', () => {
    // SAVE.md「設計図」: 同じセーブデータならどのランからも同じ一覧が見え、別のセーブデータからは見えない
    const store = new MemorySaveStore();
    const slots = SaveSlots.load(store);
    const first = slots.activeSlotId;
    assert.ok(first !== null);
    const shelf = new BlueprintShelf(slots);
    assert.equal(shelf.add(blueprint('bp-1')), true);

    const second = slots.createSlot('別のセーブデータ');
    slots.setActiveSlot(second.id);
    shelf.reload();
    assert.equal(shelf.blueprints.length, 0);
    slots.setActiveSlot(first);
    shelf.reload();
    assert.deepEqual(shelf.blueprints.map((b) => b.id), ['bp-1']);

    // アクティブなセーブデータが無ければ記録できない。
    slots.deleteSlot(first);
    slots.deleteSlot(second.id);
    shelf.reload();
    assert.equal(shelf.canRecord, false);
    assert.equal(shelf.add(blueprint('bp-2')), false);
    assert.equal(shelf.blueprints.length, 0);
  });
}
