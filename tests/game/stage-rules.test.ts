import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { CAMPAIGN_STAGE_RULES, FREE_PLAY_STAGE_RULES } from '../../src/game/stages/stage-rules';
import { Logistics, type SerializedLogistics } from '../../src/game/stages/stage-utils/logistics';
import type { EntityRegistry } from '../../src/game/dynamic/entity-registry';
import type { EntityRoster } from '../../src/game/dynamic/entity-roster';

const serialized: SerializedLogistics = {
  resupplyCheckAt: 0,
  resupplyEnabled: true,
  rcsFuelResupplyEnabled: true,
};

function logistics(automaticResupply: boolean): Logistics {
  return Logistics.deserialize(
    serialized,
    new THREE.Scene(),
    {} as EntityRegistry & EntityRoster,
    automaticResupply,
  );
}

export function register(): void {
  test('stage rules: キャンペーンは自動補給と自然修復を許可しない', () => {
    assert.deepEqual(CAMPAIGN_STAGE_RULES, { automaticResupply: false, selfRepair: false });
  });

  test('stage rules: 自由検証は自動補給と自然修復を許可する', () => {
    assert.deepEqual(FREE_PLAY_STAGE_RULES, { automaticResupply: true, selfRepair: true });
  });

  test('logistics: 直列化した自動補給設定よりステージルールを優先する', () => {
    const campaign = logistics(false);
    assert.equal(campaign.resupplyEnabled, false);
    assert.equal(campaign.rcsFuelResupplyEnabled, false);

    const freePlay = logistics(true);
    assert.equal(freePlay.resupplyEnabled, true);
    assert.equal(freePlay.rcsFuelResupplyEnabled, true);
  });
}
