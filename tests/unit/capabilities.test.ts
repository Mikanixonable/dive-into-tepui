// 搭載要素から導く機体の能力判定(§5-1)の回帰テスト。既定の設計が積むものを土台に、
// どの設計が操作対象になれるかを固定する。
import * as assert from 'node:assert/strict';
import {
  ALWAYS_IN_COVERAGE,
  CapabilityVessel,
  CoverageQuery,
  canAutopilot,
  hasBaseModule,
  hasCockpit,
  hasCommunication,
  hasEngine,
  isOperable,
} from '../../src/game/vessel/capabilities';
import { baseParts, crewedParts, hostileParts } from '../../src/game/vessel/vessel-parts';
import type { AnyPart } from '../../src/game/game-entity/parts';
import { createPart } from '../../src/game/game-entity/parts';
import { v3 } from '../../src/physics/vec3';
import { test } from '../physics/harness';

// 部品一覧だけを持つ、能力判定に必要な最小の機体。
function vesselOf(parts: readonly AnyPart[]): CapabilityVessel {
  return { parts, state: { r: v3(7.0e6, 0, 0) } };
}

const NEVER_IN_COVERAGE: CoverageQuery = { inCoverage: () => false };

export function register(): void {
  test('有人艦はコックピットを積み、操作対象になれる', () => {
    const ship = vesselOf(crewedParts(1000));
    assert.equal(hasCockpit(ship), true);
    assert.equal(hasEngine(ship), true);
    assert.equal(hasBaseModule(ship), false);
    assert.equal(isOperable(ship, ALWAYS_IN_COVERAGE), true);
  });

  test('敵対機はコックピットを積まず、操作対象にならない', () => {
    const enemy = vesselOf(hostileParts(1000));
    assert.equal(hasCockpit(enemy), false);
    assert.equal(hasCommunication(enemy), false);
    assert.equal(canAutopilot(enemy, ALWAYS_IN_COVERAGE), false);
    assert.equal(isOperable(enemy, ALWAYS_IN_COVERAGE), false);
  });

  test('軌道基地は管制室のコックピットを持ち、操作対象になれる', () => {
    const base = vesselOf(baseParts(1000));
    assert.equal(hasBaseModule(base), true);
    assert.equal(hasCockpit(base), true);
    assert.equal(isOperable(base, ALWAYS_IN_COVERAGE), true);
  });

  test('コックピットが全損すると操作対象から外れる', () => {
    const parts = crewedParts(1000);
    for (const p of parts) if (p.type === 'cockpit') p.hp = 0;
    assert.equal(isOperable(vesselOf(parts), ALWAYS_IN_COVERAGE), false);
  });

  test('無人での計画実行は自動操縦装置と通信の両方を要する', () => {
    const parts = hostileParts(1000);
    const autopilotOnly = vesselOf([...parts, createPart('autopilot', { name: 'Autopilot', maxHp: 10, hp: 10 })]);
    assert.equal(canAutopilot(autopilotOnly, ALWAYS_IN_COVERAGE), false);

    const both = vesselOf([
      ...parts,
      createPart('autopilot', { name: 'Autopilot', maxHp: 10, hp: 10 }),
      createPart('communication', { name: 'Relay', maxHp: 10, hp: 10, range: 1e7 }),
    ]);
    assert.equal(canAutopilot(both, ALWAYS_IN_COVERAGE), true);
    assert.equal(isOperable(both, ALWAYS_IN_COVERAGE), true);
    // 圏外では装置が健在でも自動操縦できない。
    assert.equal(canAutopilot(both, NEVER_IN_COVERAGE), false);
    assert.equal(isOperable(both, NEVER_IN_COVERAGE), false);
  });
}
