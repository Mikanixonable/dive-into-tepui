// 基地保存データの拡張境界。JSON 化した assembly の形検証と、旧セーブを含むドック割当の復元を固定する。
import * as assert from 'node:assert/strict';
import * as C from '../../src/game/const';
import {
  BASE_SAVE_FORMAT_VERSION,
  isAssemblySaveData,
  isSupportedBaseSaveFormat,
  resolveDockSlotIndices,
} from '../../src/game/save-data';
import { orbitalBaseAssembly } from '../../src/game/vessel/vessel-assemblies';
import { test } from '../physics/harness';

export function register(): void {
  test('base save: JSON 化した既定 assembly は保存データ境界を通る', () => {
    const raw = JSON.parse(JSON.stringify(orbitalBaseAssembly(C.BASE_MAX_HP))) as unknown;
    assert.equal(isAssemblySaveData(raw), true);
  });

  test('base save: assembly の座標破損は境界で拒否する', () => {
    const raw = JSON.parse(JSON.stringify(orbitalBaseAssembly(C.BASE_MAX_HP))) as {
      tree: { nodes: Array<{ pos: { x: number } }> };
    };
    raw.tree.nodes[0]!.pos.x = Number.NaN;
    assert.equal(isAssemblySaveData(raw), false);
  });

  test('base save: formatVersion 未指定は旧互換、未知の版は拒否する', () => {
    assert.equal(isSupportedBaseSaveFormat(undefined), true);
    assert.equal(isSupportedBaseSaveFormat(BASE_SAVE_FORMAT_VERSION), true);
    assert.equal(isSupportedBaseSaveFormat(BASE_SAVE_FORMAT_VERSION + 1), false);
    assert.equal(isSupportedBaseSaveFormat(0), false);
  });

  test('base save: dockBindings を優先し、重複・範囲外は保存順の空きへ戻す', () => {
    const slots = resolveDockSlotIndices(
      [
        { vesselId: 'ship-b', slotIndex: 3 },
        { vesselId: 'ship-a', slotIndex: 3 },
        { vesselId: 'ship-c', slotIndex: 99 },
      ],
      [{ id: 'ship-a' }, { id: 'ship-b' }, { id: 'ship-c' }, { id: 'ship-d' }],
      4,
    );
    // 同じスロットを要求する場合は、船の保存順を優先し、後続を空きへ退避する。
    assert.deepEqual(slots, [3, 0, 1, 2]);
  });

  test('base save: dockBindings が無い旧セーブは保存順で割り当てる', () => {
    assert.deepEqual(
      resolveDockSlotIndices(undefined, [{ id: 'ship-a' }, { id: 'ship-b' }], 4),
      [0, 1],
    );
  });
}
