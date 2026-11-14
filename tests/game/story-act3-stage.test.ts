// ストーリー第3幕: 敵の配置表(編隊指揮を含む)・規模ゲートの格・襲撃の敵 id が
// GAME.md 11.2 / 11.5 の規則どおりであることを検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { ConstructionScaleGate } from '../../src/game/campaign/construction-scale-gate';
import { SHIPYARD_CONSTRUCTION_MATERIALS } from '../../src/game/campaign/story-economy';
import { STORY_LUNAR_BASE_ID } from '../../src/game/stages/stage-story-lunar';
import {
  STORY_ACT2_FACILITY_TIERS, STORY_EARTH_OBSERVATION_POST_ID, STORY_LUNAR_ORBIT_DOCK_ID,
} from '../../src/game/stages/stage-story-act2';
import {
  STORY_ACT3_COMMANDER_ID, STORY_ACT3_ENEMIES, STORY_ACT3_ENEMY_COUNT,
  STORY_ACT3_RAID_ENEMY_COUNT, storyAct3RaidEnemyId,
} from '../../src/game/stages/stage-story-act3';

export function register(): void {
  test('story act3: 敵の配置表は金属機と組み立て型で計18機、総数の宣言と一致する', () => {
    // GAME.md 11.2: 第3幕の敵は金属機と組み立て型、計18機。
    assert.equal(STORY_ACT3_ENEMIES.length, STORY_ACT3_ENEMY_COUNT);
    assert.equal(STORY_ACT3_ENEMY_COUNT, 18);
    const metal = STORY_ACT3_ENEMIES.filter((spec) => spec.kind === 'metal');
    const assembly = STORY_ACT3_ENEMIES.filter((spec) => spec.kind === 'assembly');
    assert.ok(metal.length > 0);
    assert.ok(assembly.length > 0);
    assert.equal(metal.length + assembly.length, 18);
    // 撃破の不可逆化のため、敵 id は重複しない安定した識別子である。
    assert.equal(new Set(STORY_ACT3_ENEMIES.map((spec) => spec.id)).size, 18);
  });

  test('story act3: 編隊は指揮機1機と、その指揮機を指す僚機からなる', () => {
    // GAME.md 11.1: 金属機には編隊を指揮する指揮機があり、指揮機を失った編隊は射撃を止める。
    const commanders = STORY_ACT3_ENEMIES.filter(
      (spec) => spec.kind === 'metal' && spec.id === STORY_ACT3_COMMANDER_ID,
    );
    assert.equal(commanders.length, 1);
    assert.equal(commanders[0]?.kind === 'metal' ? commanders[0].commanderId : 'missing', null);
    const wingmen = STORY_ACT3_ENEMIES.filter(
      (spec) => spec.kind === 'metal' && spec.commanderId === STORY_ACT3_COMMANDER_ID,
    );
    assert.equal(wingmen.length, 3);
    // 指揮機以外を指揮機として指す敵はいない。
    for (const spec of STORY_ACT3_ENEMIES) {
      if (spec.kind !== 'metal' || spec.commanderId === null) continue;
      assert.equal(spec.commanderId, STORY_ACT3_COMMANDER_ID);
    }
  });

  test('story act3: 造船所の格は軌道ドックより大きく、建設費は正の素材量', () => {
    // GAME.md 11.2: 規模ゲートの格は地表基地・軌道ドック・軌道造船所の順に大きい。
    const tiers = {
      ...STORY_ACT2_FACILITY_TIERS,
      [STORY_EARTH_OBSERVATION_POST_ID]: 'orbital-shipyard' as const,
    };
    const gate = new ConstructionScaleGate(tiers);
    assert.equal(gate.tierOf(STORY_LUNAR_BASE_ID), 'surface-base');
    assert.equal(gate.tierOf(STORY_LUNAR_ORBIT_DOCK_ID), 'orbital-dock');
    assert.equal(gate.massLimitKgOf(STORY_EARTH_OBSERVATION_POST_ID), 60_000);
    assert.ok(
      (gate.massLimitKgOf(STORY_EARTH_OBSERVATION_POST_ID) ?? 0)
      > (gate.massLimitKgOf(STORY_LUNAR_ORBIT_DOCK_ID) ?? Number.POSITIVE_INFINITY),
    );
    assert.ok(SHIPYARD_CONSTRUCTION_MATERIALS > 0);
  });

  test('story act3: 襲撃の敵 id は幕の敵 id と混ざらない', () => {
    // GAME.md 11.5: 襲撃の敵は第3幕の敵の総数には数えない。
    const specIds = new Set(STORY_ACT3_ENEMIES.map((spec) => spec.id));
    for (let member = 0; member < STORY_ACT3_RAID_ENEMY_COUNT; member++) {
      assert.equal(specIds.has(storyAct3RaidEnemyId(0, member)), false);
    }
    assert.equal(storyAct3RaidEnemyId(2, 1), 'story-act3-raid-2-1');
  });
}
