// セーブスロットのキャンペーン状態が、開始・差し替え・再読み込み・複製を通して保たれることを検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { SaveSlots } from '../../src/launcher/save/save-slots';
import { SAVE_INDEX_VERSION } from '../../src/launcher/save/save-store';
import type { SaveIndex } from '../../src/launcher/save/slot-data';
import { MemorySaveStore } from './memory-save-store';
import { createCampaignState, recordCommandCoreDestroyed } from '../../src/game/campaign/campaign-state';

export function register(): void {
  test('save-campaign: 未開始のスロットはキャンペーンを持たず、開始すると初期状態が保存される', () => {
    // SAVE.md「キャンペーン状態」: 持っていないスロットはストーリーモード未開始である。
    const store = new MemorySaveStore();
    const slots = SaveSlots.load(store);
    const slotId = slots.activeSlotId;
    assert.ok(slotId !== null);
    assert.equal(slots.campaign(slotId), null);

    const started = slots.startCampaign(slotId);
    assert.deepEqual(started, createCampaignState());
    // 開始は冪等で、進行中のキャンペーンを初期化し直すことはない。
    assert.equal(slots.startCampaign(slotId), started);

    // 索引へ書き戻されているので、読み直しても残る。
    const reloaded = SaveSlots.load(store);
    assert.deepEqual(reloaded.campaign(slotId), createCampaignState());
  });

  test('save-campaign: 中枢破壊の差し替えが保存され、複製先にもキャンペーンが持ち込まれる', () => {
    // SAVE.md「キャンペーン状態」: 複製ではキャンペーン状態もそのまま持ち込まれる。
    const store = new MemorySaveStore();
    const slots = SaveSlots.load(store);
    const slotId = slots.activeSlotId;
    assert.ok(slotId !== null);
    const started = slots.startCampaign(slotId);
    assert.ok(started !== null);
    slots.updateCampaign(slotId, recordCommandCoreDestroyed(started));
    assert.equal(slots.campaign(slotId)?.commandCore, 'destroyed');

    const reloaded = SaveSlots.load(store);
    assert.equal(reloaded.campaign(slotId)?.commandCore, 'destroyed');

    const copy = slots.duplicateSlot(slotId);
    assert.ok(copy !== null);
    assert.equal(copy.campaign?.commandCore, 'destroyed');
  });

  test('save-campaign: キャンペーン項目を持たない索引は未開始として読む', () => {
    // SAVE.md「キャンペーン状態」: 項目の追加では形式の版を上げず、欠けた項目は未開始として読む。
    const store = new MemorySaveStore();
    const legacy = {
      version: SAVE_INDEX_VERSION,
      activeSlotId: 'legacy',
      slots: [{
        id: 'legacy', name: '旧い記録', createdAtReal: 0, lastPlayedAtReal: 0, lastRun: null, stages: [],
      }],
    } as unknown as SaveIndex;
    store.writeIndex(legacy);

    const slots = SaveSlots.load(store);
    assert.equal(slots.campaign('legacy'), null);
    assert.deepEqual(slots.startCampaign('legacy'), createCampaignState());
  });
}
