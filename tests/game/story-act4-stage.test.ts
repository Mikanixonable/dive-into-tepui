// ストーリー第4幕: モルニヤ群の配置表・指揮中枢とその陣形・敵 id の一意性が
// GAME.md 11.2 / 11.3 の規則どおりであることを検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  STORY_ACT4_ALL_ENEMY_IDS, STORY_ACT4_CORE_GUARDS, STORY_ACT4_CORE_SPEC,
  STORY_ACT4_ENEMY_COUNT, STORY_ACT4_FORMATION, STORY_ACT4_FORMATION_COMMANDER_ID,
  STORY_ACT4_MOLNIYA_ENEMIES, STORY_COMMAND_CORE_ID,
} from '../../src/game/stages/stage-story-act4';

export function register(): void {
  test('story act4: モルニヤ群は16機で、総数の宣言と一致する', () => {
    // GAME.md 11.2: 第4幕のモルニヤ群は16機。中枢とその陣形はこの数に含めない。
    assert.equal(STORY_ACT4_MOLNIYA_ENEMIES.length, STORY_ACT4_ENEMY_COUNT);
    assert.equal(STORY_ACT4_ENEMY_COUNT, 16);
  });

  test('story act4: 指揮中枢は安定 id を持ち、陣形と合わせて全 id が一意', () => {
    // GAME.md 11.3: 中枢の撃破が決着に直結するため、その id は安定していなければならない。
    assert.equal(STORY_ACT4_CORE_SPEC.id, STORY_COMMAND_CORE_ID);
    assert.equal(STORY_COMMAND_CORE_ID, 'story-command-core');
    const all = STORY_ACT4_ALL_ENEMY_IDS;
    assert.equal(new Set(all).size, all.length);
    // 内訳: モルニヤ群16 + 中枢1 + 護衛4 + 編隊4。
    assert.equal(all.length, 16 + 1 + STORY_ACT4_CORE_GUARDS.length + STORY_ACT4_FORMATION.length);
    assert.ok(all.includes(STORY_COMMAND_CORE_ID));
  });

  test('story act4: 中枢の編隊は指揮機1機と、その指揮機を指す僚機からなる', () => {
    // GAME.md 11.1: 金属機には編隊を指揮する指揮機があり、指揮機を失った編隊は射撃を止める。
    const commanders = STORY_ACT4_FORMATION.filter((spec) => spec.id === STORY_ACT4_FORMATION_COMMANDER_ID);
    assert.equal(commanders.length, 1);
    assert.equal(commanders[0]?.commanderId, null);
    const wingmen = STORY_ACT4_FORMATION.filter(
      (spec) => spec.commanderId === STORY_ACT4_FORMATION_COMMANDER_ID,
    );
    assert.equal(wingmen.length, 3);
    for (const spec of STORY_ACT4_FORMATION) {
      if (spec.commanderId === null) continue;
      assert.equal(spec.commanderId, STORY_ACT4_FORMATION_COMMANDER_ID);
    }
  });

  test('story act4: 護衛は中枢と別 id の組み立て型で、中枢の近傍に置かれる', () => {
    // GAME.md 11.2: 中枢は編隊指揮型の大編隊と組み立て型の護衛に守られる。
    assert.equal(STORY_ACT4_CORE_GUARDS.length, 4);
    for (const guard of STORY_ACT4_CORE_GUARDS) {
      assert.notEqual(guard.id, STORY_COMMAND_CORE_ID);
      assert.ok(Math.abs(guard.phaseRad - STORY_ACT4_CORE_SPEC.phaseRad) < 0.1);
    }
  });
}
