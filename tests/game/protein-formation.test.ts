import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { isFormationEnergyAvailable } from '../../src/game/dynamic/dynamic-entity/protein-enemy';
import { countAttackingEnemiesInGroup } from '../../src/game/dynamic/dynamic-entity/enemy-attack-group';
import type { FormationRole } from '../../src/game/dynamic/dynamic-entity/entity-kind';

interface FormationMember {
  readonly motion: { readonly alive: boolean };
  readonly formationId: string | null;
  readonly formationRole: FormationRole | null;
}

interface AttackingMember {
  readonly motion: { readonly alive: boolean };
  readonly attackGroupId: string;
  readonly isBursting: boolean;
}

export function register(): void {
  test('protein formation: an attacker needs a living energy member in the same formation', () => {
    const members: readonly FormationMember[] = [
      { motion: { alive: true }, formationId: 'formation-1', formationRole: 'attacker' },
      { motion: { alive: true }, formationId: 'formation-2', formationRole: 'energy' },
      { motion: { alive: false }, formationId: 'formation-1', formationRole: 'energy' },
    ];
    assert.equal(isFormationEnergyAvailable('attacker', 'formation-1', members), false);
    assert.equal(isFormationEnergyAvailable('attacker', 'formation-2', members), true);
  });

  test('protein formation: non-attackers and ungrouped enemies keep the ordinary condition', () => {
    const members: readonly FormationMember[] = [];
    assert.equal(isFormationEnergyAvailable('shield', 'formation-1', members), true);
    assert.equal(isFormationEnergyAvailable('energy', 'formation-1', members), true);
    assert.equal(isFormationEnergyAvailable('attacker', null, members), true);
    assert.equal(isFormationEnergyAvailable(null, null, members), true);
  });

  test('protein formation: a living energy member from another formation cannot supply an attacker', () => {
    const members: readonly FormationMember[] = [
      { motion: { alive: true }, formationId: 'formation-2', formationRole: 'energy' },
      { motion: { alive: true }, formationId: 'formation-1', formationRole: 'shield' },
    ];
    assert.equal(isFormationEnergyAvailable('attacker', 'formation-1', members), false);
  });

  test('enemy attack groups: display colors do not consume another group limit', () => {
    const members: readonly AttackingMember[] = [
      { motion: { alive: true }, attackGroupId: 'formation-a', isBursting: true },
      { motion: { alive: true }, attackGroupId: 'formation-b', isBursting: true },
      { motion: { alive: false }, attackGroupId: 'formation-a', isBursting: true },
      { motion: { alive: true }, attackGroupId: 'formation-a', isBursting: false },
    ];
    assert.equal(countAttackingEnemiesInGroup(members, 'formation-a'), 1);
    assert.equal(countAttackingEnemiesInGroup(members, 'formation-b'), 1);
  });
}
