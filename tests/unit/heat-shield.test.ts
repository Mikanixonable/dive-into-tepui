// 熱シールドが与える熱防御(§11-3)の回帰テスト。守る向きが対気速度から外れれば効かず、
// アブレータが尽きれば失われることを固定する。
import * as assert from 'node:assert/strict';
import * as C from '../../src/game/const';
import { v3 } from '../../src/physics/vec3';
import type { HeatShieldPart } from '../../src/game/game-entity/parts';
import { crewedAssembly } from '../../src/game/vessel/vessel-assemblies';
import { UNSHIELDED, ablate, heatShielding, shieldHalfAngle } from '../../src/game/vessel/heat-shield';
import type { PartPlacement } from '../../src/game/vessel/assembly';
import { test } from '../physics/harness';

function shieldOf(placements: readonly PartPlacement[]): HeatShieldPart {
  const found = placements.find((p) => p.part.type === 'heat_shield');
  assert.ok(found, '既定の有人艦は熱シールドを積む');
  return found!.part as HeatShieldPart;
}

export function register(): void {
  test('立体角と半頂角が Ω = 2π(1 − cosθ) で対応する', () => {
    assert.ok(Math.abs(shieldHalfAngle(0) - 0) < 1e-12);
    assert.ok(Math.abs(shieldHalfAngle(2 * Math.PI) - Math.PI / 2) < 1e-12);
    assert.ok(Math.abs(shieldHalfAngle(4 * Math.PI) - Math.PI) < 1e-12);
  });

  test('機首を対気速度へ向けているあいだだけ熱防御が効く', () => {
    const { tree, placements } = crewedAssembly(C.PLAYER_MAX_HP);
    const nose = heatShielding(tree, placements, v3(0, 0, 1));
    assert.ok(nose.shielded > 0, `shielded ${nose.shielded}`);
    assert.ok(nose.tempLimit > C.MAX_HULL_TEMP);
    assert.ok(nose.dynPressureLimit > C.MAX_DYN_PRESSURE);
    // 横腹を向ければ守られない。閾値は素の値へ戻る。
    assert.deepEqual(heatShielding(tree, placements, v3(1, 0, 0)), UNSHIELDED);
    assert.deepEqual(heatShielding(tree, placements, v3(0, 0, -1)), UNSHIELDED);
    // 向きが決まらない(対気速度が 0)なら守られない。
    assert.deepEqual(heatShielding(tree, placements, v3()), UNSHIELDED);
  });

  test('熱シールドを積まない機体は素の閾値を持つ', () => {
    const { tree, placements } = crewedAssembly(C.PLAYER_MAX_HP);
    const without = placements.filter((p) => p.part.type !== 'heat_shield');
    assert.deepEqual(heatShielding(tree, without, v3(0, 0, 1)), UNSHIELDED);
    // 積んだ機体のほうが高い加熱率・動圧に耐える。
    assert.ok(heatShielding(tree, placements, v3(0, 0, 1)).tempLimit > UNSHIELDED.tempLimit);
  });

  test('アブレータが尽きた熱シールドは機能を失う', () => {
    const { tree, placements } = crewedAssembly(C.PLAYER_MAX_HP);
    const shield = shieldOf(placements);
    const before = shield.ablatorMass;
    ablate(placements, 1e9);
    assert.ok(shield.ablatorMass < before, `${shield.ablatorMass} < ${before}`);
    assert.ok(heatShielding(tree, placements, v3(0, 0, 1)).shielded > 0);
    // 残りをすべて削り切ると、閾値は素の値へ戻る。
    ablate(placements, 1e30);
    assert.equal(shield.ablatorMass, 0);
    assert.deepEqual(heatShielding(tree, placements, v3(0, 0, 1)), UNSHIELDED);
  });
}
