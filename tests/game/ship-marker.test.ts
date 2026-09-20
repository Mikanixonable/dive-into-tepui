// 視点が無い状態でも艦マーカーが表示導出を壊さないことを検査する。
import * as assert from 'node:assert/strict';
import { ModularShip } from '../../src/game/ship/modular-ship';
import { MARKER_PRIORITY } from '../../src/game/marker/marker-priority';
import { v3 } from '../../src/math/vec3';
import { test } from '../harness';

export function register(): void {
  test('ship-marker: 視点が無いときも基地マーカーの距離計算を行わない', () => {
    const ship = {
      id: 'base-1',
      mapKind: 'base',
      capabilities: { role: 'base' },
    } as unknown as ModularShip;

    const item = ModularShip.prototype.markerItem.call(ship, null, v3(1, 2, 3), v3(), 'map', false);

    assert.equal(item.priority, MARKER_PRIORITY.BASE);
    assert.equal(item.bearing.visible, false);
  });
}
