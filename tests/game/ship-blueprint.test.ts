// 設計図の検証が、壊れた値を拒み正しい先端部を通すことを検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { ShipAssembly } from '../../src/game/ship/ship-assembly';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import { createShipModuleInstance } from '../../src/game/ship/ship-module-instance';
import { isShipBlueprint } from '../../src/game/ship/ship-blueprint';
import { serializeShipAssembly, type SerializedShipAssembly } from '../../src/game/ship/ship-save';

// tank → thruster の2モジュールから成る先端部。
function piece(): SerializedShipAssembly {
  const assembly = new ShipAssembly(SHIP_MODULE_CATALOG, true);
  assembly.addRoot(createShipModuleInstance(SHIP_MODULE_CATALOG.require('tank-3-main'), 'tank'));
  assembly.append(createShipModuleInstance(SHIP_MODULE_CATALOG.require('thruster-standard'), 'thruster'));
  return serializeShipAssembly(assembly);
}

// piece に任意の値を載せた設計図の形。
function blueprint(pieceValue: unknown): Record<string, unknown> {
  return { id: 'bp-1', name: 'テスト設計図', createdAtReal: 0, piece: pieceValue };
}

export function register(): void {
  test('ship blueprint: 正しい先端部を持つ設計図を通す', () => {
    assert.equal(isShipBlueprint(blueprint(piece())), true);
  });

  test('ship blueprint: 設計図の形をしていない値を拒む', () => {
    const base = blueprint(piece());
    for (const value of [
      null,
      '設計図でない値',
      42,
      { name: 'x', createdAtReal: 0, piece: piece() }, // 識別子が無い
      { ...base, id: '' }, // 空の識別子
      { ...base, name: 7 }, // 名前が文字列でない
      { ...base, createdAtReal: 'x' }, // 時刻が数値でない
      { ...base, piece: undefined }, // 先端部が無い
    ]) {
      assert.equal(isShipBlueprint(value), false, JSON.stringify(value));
    }
  });

  test('ship blueprint: 復元できない先端部を載せた設計図を拒む', () => {
    const moduleA = {
      id: 'a', definitionId: 'tank-3-main', kind: 'tank', hp: 100, temperature: 300, fuelKind: 'main', fuel: 1,
    };
    const moduleB = { id: 'b', definitionId: 'thruster-standard', kind: 'thruster', hp: 100, temperature: 300 };
    for (const pieceValue of [
      null,
      { playerOwned: true, modules: [], connections: [] }, // モジュールが無い
      // 定義が無いモジュールを含む
      { playerOwned: true, modules: [{ ...moduleA, definitionId: 'no-such-definition' }], connections: [] },
      // 接続が無く、木でない
      { playerOwned: true, modules: [moduleA, moduleB], connections: [] },
      // モジュール id が重複している
      { playerOwned: true, modules: [moduleA, { ...moduleA }], connections: [] },
    ]) {
      assert.equal(isShipBlueprint(blueprint(pieceValue)), false, JSON.stringify(pieceValue));
    }
  });
}
