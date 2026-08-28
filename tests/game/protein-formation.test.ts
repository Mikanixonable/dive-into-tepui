import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { isFormationEnergyAvailable, type FormationRole } from '../../src/game/game-entity/enemy-formation';

type FormationMember = {
  readonly alive: boolean;
  readonly formationId?: string;
  readonly formationRole?: FormationRole;
};

export function register(): void {
  test('protein formation: an attacker needs a living energy member in the same formation', () => {
    const members: readonly FormationMember[] = [
      { alive: true, formationId: 'formation-1', formationRole: 'attacker' },
      { alive: true, formationId: 'formation-2', formationRole: 'energy' },
      { alive: false, formationId: 'formation-1', formationRole: 'energy' },
    ];
    assert.equal(isFormationEnergyAvailable('attacker', 'formation-1', members), false);
    assert.equal(isFormationEnergyAvailable('attacker', 'formation-2', members), true);
  });

  test('protein formation: non-attackers and ungrouped enemies keep the ordinary condition', () => {
    const members: readonly FormationMember[] = [];
    assert.equal(isFormationEnergyAvailable('shield', 'formation-1', members), true);
    assert.equal(isFormationEnergyAvailable('energy', 'formation-1', members), true);
    assert.equal(isFormationEnergyAvailable('attacker', undefined, members), true);
    assert.equal(isFormationEnergyAvailable(undefined, undefined, members), true);
  });

  test('protein formation: a living energy member from another formation cannot supply an attacker', () => {
    const members: readonly FormationMember[] = [
      { alive: true, formationId: 'formation-2', formationRole: 'energy' },
      { alive: true, formationId: 'formation-1', formationRole: 'shield' },
    ];
    assert.equal(isFormationEnergyAvailable('attacker', 'formation-1', members), false);
  });
}
