// 鹵獲の積荷の待ち行列: 授与の順を保って積み、直列化して戻し、取り出すと空になることを検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { SalvageCargo } from '../../src/game/stages/stage-utils/salvage-cargo';

export function register(): void {
  test('積荷: 授与の順に積み、取り出すと授与の順のまま空になる', () => {
    const cargo = new SalvageCargo();
    cargo.add('gunpod');
    cargo.add('supply-pod');
    assert.deepEqual(cargo.takeAll(), ['gunpod', 'supply-pod']);
    assert.deepEqual(cargo.pending, []);
  });

  test('積荷: 直列化した積荷は授与の順に戻り、知らない種類の記録は読み捨てる', () => {
    const restored = SalvageCargo.deserialize(['gunpod', 'bogus', 'assault-craft', 3]);
    assert.deepEqual(restored.pending, ['gunpod', 'assault-craft']);
    assert.deepEqual(restored.serialize(), ['gunpod', 'assault-craft']);
  });

  test('積荷: 記録が無ければ空の待ち行列から始まる', () => {
    assert.deepEqual(SalvageCargo.deserialize(undefined).pending, []);
  });
}
