// 補給艇: 建造ドックを1基持つコックピットのない物資で、積荷の鹵獲品は損傷して積まれる。
// 補給艇を届ける位相ずらしは、同じ軌道の上を前へ進み、高度と速さを保つ。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { len, sub, v3 } from '../../src/math/vec3';
import { kinematicState } from '../../src/physics/kinematic-state';
import { phaseShiftedBy } from '../../src/game/stages/stage-utils/logistics';
import { createSalvageTenderPreset } from '../../src/game/ship/ship-presets';

export function register(): void {
  test('補給艇: 建造ドックを1基持ち、コックピットを持たない', () => {
    const tender = createSalvageTenderPreset([]);
    assert.equal(tender.modules.filter(module => module.kind === 'dock').length, 1);
    assert.equal(tender.modules.filter(module => module.kind === 'cockpit').length, 0);
  });

  test('補給艇: 積荷の強襲艇のコックピットは損傷して積まれ、船体は物資のまま', () => {
    const tender = createSalvageTenderPreset(['assault-craft']);
    const cockpits = tender.modules.filter(module => module.kind === 'cockpit');
    assert.equal(cockpits.length, 1);
    assert.equal(cockpits[0]?.hp, 0);
  });

  test('補給艇: 積荷は授与の順に連なり、同じ種類を重ねても識別子が衝突しない', () => {
    const tender = createSalvageTenderPreset(['gunpod', 'supply-pod', 'assault-craft', 'gunpod']);
    const ids = tender.modules.map(module => module.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(tender.modules.filter(module => module.kind === 'cockpit').length, 1);
  });

  test('位相ずらし: 同じ軌道の上を指定の距離だけ前へ進み、高度と速さを保つ', () => {
    const state = kinematicState<'eci'>(0, v3(7000e3, 0, 0), v3(0, 7546, 0));
    const shifted = phaseShiftedBy(state, 400);
    assert.ok(Math.abs(len(shifted.r) - len(state.r)) < 1e-3);
    assert.ok(Math.abs(len(shifted.v) - len(state.v)) < 1e-6);
    assert.ok(Math.abs(len(sub(shifted.r, state.r)) - 400) < 1);
  });
}
