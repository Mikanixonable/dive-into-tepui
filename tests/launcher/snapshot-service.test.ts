// 記録の読み出しが、形式の版の一致しない記録を拒むことを検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { SaveSlots } from '../../src/launcher/save/save-slots';
import { SnapshotService } from '../../src/launcher/save/snapshot-service';
import { MemorySaveStore } from './memory-save-store';
import { serializedGame } from './serialized-game';

export function register(): void {
  test('snapshot-service: 版が一致しない記録は読み込まず、例外にもならない', () => {
    // SAVE.md「形式の版」: 版が一致しない記録は読み込めない。旧い版の記録を新しい版へ変換して読むことはしない
    const store = new MemorySaveStore();
    const service = new SnapshotService(store, SaveSlots.load(store));
    const current = serializedGame('stage00');
    store.writeSnapshot('current', current);
    store.writeRawSnapshot('same-shape', { ...current, version: 3 });
    // 版 3 の記録は、進行と視点を分けずに最上位へ並べていた。
    store.writeRawSnapshot('flat', {
      version: 3,
      stageId: 'stage00',
      ephemerisContext: current.progress.ephemerisContext,
      simTime: 0,
      entities: [],
    });

    assert.notEqual(service.load('current', 'stage00'), null);
    assert.equal(service.load('same-shape', 'stage00'), null);
    assert.equal(service.load('flat', 'stage00'), null);
  });
}
