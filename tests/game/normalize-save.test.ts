// normalize-save.ts の回帰テスト。期待値の正本は「保存済みの旧いスナップショットがどんな形か」
// という、コードの外にある事実なので、読み替えの1つずつを固定する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { normalizeSaveData } from '../../src/game/save/normalize-save';
import type { GameSaveData } from '../../src/game/save/save-data';

// 読み替えの対象になるフィールドだけを持つ最小のスナップショット。他のフィールドは
// 正規化に関わらないので、型の穴を埋めるためだけに置く。
function saveWith(extra: Record<string, unknown>): GameSaveData {
  return {
    version: 2,
    stageId: 'creative',
    simTime: 0,
    phaseOffsets: {},
    players: [],
    activeControlledId: null,
    enemies: [],
    ammoPickups: [],
    bases: [],
    stage: {} as GameSaveData['stage'],
    ...extra,
  } as GameSaveData;
}

// FocusCameraSaveData のうち、読み替えに関わらない欄。
const CAMERA_REST = {
  offset: { x: 0, y: 0, z: 0 },
  pan: { x: 0, y: 0, z: 0 },
  up: { x: 0, y: 1, z: 0 },
};

export function register(): void {
  test('normalize-save: 旧キー activePlayerId を activeControlledId として読む', () => {
    const normalized = normalizeSaveData(saveWith({ activeControlledId: undefined, activePlayerId: 'ship-1' }));
    assert.equal(normalized?.activeControlledId, 'ship-1');
    assert.equal('activePlayerId' in (normalized as object), false);
  });

  test('normalize-save: 今のキーがあれば旧キーに上書きされない', () => {
    const normalized = normalizeSaveData(saveWith({ activeControlledId: 'base-1', activePlayerId: 'ship-1' }));
    assert.equal(normalized?.activeControlledId, 'base-1');
  });

  test('normalize-save: 注視対象の役割トークン @activeShip を @controlled へ読み替える', () => {
    const camera = {
      view: 'combat',
      chase: { ...CAMERA_REST, rotatingWith: null, focus: { kind: 'object', id: '@activeShip' } },
      overview: { ...CAMERA_REST, rotatingWith: null, focus: { kind: 'object', id: 'earth' } },
    };
    const normalized = normalizeSaveData(saveWith({ camera }));
    const chase = normalized?.camera?.chase as { focus: { id: string } };
    assert.equal(chase.focus.id, '@controlled');
    // 天体 id は素通しする。
    assert.equal((normalized?.camera?.overview.focus as { id: string }).id, 'earth');
  });

  test('normalize-save: 固定点フォーカスの基準・回転対象の役割トークンも読み替える', () => {
    const camera = {
      view: 'map',
      chase: { ...CAMERA_REST, rotatingWith: null, focus: { kind: 'object', id: 'earth' } },
      overview: {
        ...CAMERA_REST,
        rotatingWith: { kind: 'revolution', id: '@activeShip' },
        focus: {
          kind: 'point',
          center: '@activeShip',
          rotatingWith: { kind: 'revolution', id: '@activeShip' },
          point: { x: 0, y: 0, z: 0 },
        },
      },
    };
    const normalized = normalizeSaveData(saveWith({ camera }));
    const overview = normalized?.camera?.overview as {
      rotatingWith: { id: string };
      focus: { center: string; rotatingWith: { id: string } };
    };
    assert.equal(overview.focus.center, '@controlled');
    assert.equal(overview.focus.rotatingWith.id, '@controlled');
    assert.equal(overview.rotatingWith.id, '@controlled');
  });

  test('normalize-save: 姿勢追従と公転天体 id は役割トークンでないので触らない', () => {
    const camera = {
      view: 'combat',
      chase: { ...CAMERA_REST, rotatingWith: { kind: 'attitude' }, focus: { kind: 'object', id: 'ship-1' } },
      overview: { ...CAMERA_REST, rotatingWith: 'moon', focus: { kind: 'object', id: 'moon' } },
    };
    const normalized = normalizeSaveData(saveWith({ camera }));
    assert.deepEqual((normalized?.camera?.chase as { rotatingWith: unknown }).rotatingWith, { kind: 'attitude' });
    assert.equal(normalized?.camera?.overview.rotatingWith, 'moon');
  });

  test('normalize-save: 旧形式の補給キー ammos を ammoPickups として読む', () => {
    const normalized = normalizeSaveData(saveWith({ ammoPickups: undefined, ammos: [] }));
    assert.deepEqual(normalized?.ammoPickups, []);
    assert.equal('ammos' in (normalized as object), false);
    // RCS 燃料と分離ブースターは旧スナップショットに無いので、空配列へ正規化する。
    assert.deepEqual(normalized?.rcsFuelPickups, []);
    assert.deepEqual(normalized?.detachedBoosters, []);
  });

  test('normalize-save: 補給の配列がどちらのキーでも無ければ読めないものとして落とす', () => {
    assert.equal(normalizeSaveData(saveWith({ ammoPickups: undefined })), null);
  });

  test('normalize-save: カメラを持たない旧スナップショットもそのまま通る', () => {
    const normalized = normalizeSaveData(saveWith({}));
    assert.notEqual(normalized, null);
    assert.equal(normalized?.camera, undefined);
  });
}
