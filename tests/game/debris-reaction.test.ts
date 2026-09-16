import * as assert from 'node:assert/strict';
import type { WorldSfx } from '../../src/audio/sfx/world-sfx';
import { v3 } from '../../src/math/vec3';
import { kinematicState, type KinematicState } from '../../src/physics/kinematic-state';
import { DebrisReaction } from '../../src/game/dynamic/dynamic-entity/debris-reaction';
import { DynamicMotion } from '../../src/game/dynamic/dynamic-motion';
import type { FlashEffects } from '../../src/game/vfx/flash-effects';
import type { Contact } from '../../src/game/dynamic/dynamic-entity/contact';
import { test } from '../harness';

class TestWorldSfx {
  public clankCount = 0;

  public clank(): void {
    this.clankCount++;
  }
}

function state(x: number): KinematicState<'eci'> {
  return kinematicState<'eci'>(0, v3(x, 0, 0), v3());
}

function contact(normalX: number, selfX: number, otherX: number): Contact {
  return {
    t: 0,
    point: v3(),
    normal: v3(normalX, 0, 0),
    selfState: state(selfX),
    otherState: state(otherX),
  };
}

function motion(stateValue: KinematicState<'eci'>, behavior: object): DynamicMotion {
  return new DynamicMotion(stateValue, { behavior: behavior as DynamicMotion['behavior'] });
}

export function register(): void {
  test('debris-reaction: 薬莢同士の接触音は両側通知から1回だけ鳴る', () => {
    const sfx = new TestWorldSfx();
    const effects = {} as FlashEffects;
    const firstReaction = new DebrisReaction('casing', 0, sfx as unknown as WorldSfx, effects);
    const secondReaction = new DebrisReaction('casing', 0, sfx as unknown as WorldSfx, effects);
    const first = motion(state(0), firstReaction);
    const second = motion(state(1), secondReaction);

    firstReaction.onEntityContact(first, second, contact(1, 0, 1));
    secondReaction.onEntityContact(second, first, contact(-1, 1, 0));

    assert.equal(sfx.clankCount, 1);
  });

  test('debris-reaction: 薬莢と自機の接触音は鳴り続ける', () => {
    const sfx = new TestWorldSfx();
    const reaction = new DebrisReaction('casing', 0, sfx as unknown as WorldSfx, {} as FlashEffects);
    const casing = motion(state(0), reaction);
    const player = motion(state(1), { contactKind: 'player' });

    reaction.onEntityContact(casing, player, contact(1, 0, 1));

    assert.equal(sfx.clankCount, 1);
  });
}
