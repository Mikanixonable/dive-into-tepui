// 波状攻撃の全滅の波間の待ち: 補給艇が届いた波間は、届いた時点の待ちを全滅による短縮で縮めない。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { EntityIdAllocators } from '../../src/game/dynamic/dynamic-entity/entity-id';
import type { ModularShip } from '../../src/game/ship/modular-ship';
import { WaveAttack, type WaveAttackStage } from '../../src/game/stages/stage-utils/wave-attack';

// 交戦中の波状攻撃。onLull は lullResults を先頭から順に返し、尽きたら届けない(false)。
function activeAttack(spawnTimer: number, lullResults: readonly boolean[]): { attack: WaveAttack; stage: WaveAttackStage } {
  const results = [...lullResults];
  const attack = new WaveAttack(
    { record: (): void => {} }, new THREE.Scene(), [], new EntityIdAllocators(), 'active_combat', spawnTimer, 1,
  );
  const stage = {
    addEnemy: (): void => {},
    onLull: (): boolean => results.shift() ?? false,
  } as unknown as WaveAttackStage;
  return { attack, stage };
}

const player = {} as ModularShip;

export function register(): void {
  test('波間の待ち: 補給艇のない全滅の波間は、待ちを 2 秒へ縮めて次の波へ進む', () => {
    const { attack, stage } = activeAttack(30, [false]);
    attack.update(0, player, [], 0, stage);
    assert.equal(attack.serialize().spawnTimer, 2);
  });

  test('波間の待ち: 補給艇が届いた全滅の波間は、待ちを 60 秒に保ち、縮めずに数える', () => {
    const { attack, stage } = activeAttack(30, [true, false]);
    attack.update(0, player, [], 0, stage);
    assert.equal(attack.serialize().spawnTimer, 60);
    assert.equal(attack.serialize().lullHeld, true);

    attack.update(0, player, [], 0, stage);
    assert.equal(attack.serialize().spawnTimer, 60);

    attack.update(30, player, [], 0, stage);
    assert.equal(attack.serialize().spawnTimer, 30);
  });
}
