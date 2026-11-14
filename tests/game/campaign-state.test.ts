// キャンペーン状態の遷移が、GAME.md 11.2/11.3 の進行規則どおりであることを検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  addStockpile,
  advanceCampaignAct,
  applyCampaignEvents,
  createCampaignState,
  isCampaignCleared,
  recordCommandCoreDestroyed,
  recordEnemyDefeated,
  recordShipyardBuilt,
  spendStockpile,
  stockpileOf,
} from '../../src/game/campaign/campaign-state';

export function register(): void {
  test('campaign-state: 初期状態は第1幕・中枢は健在・備蓄と撃破記録は空で、クリアではない', () => {
    // GAME.md 11.2: キャンペーンは第1幕から始まる。
    const state = createCampaignState();
    assert.equal(state.act, 1);
    assert.equal(state.commandCore, 'intact');
    assert.deepEqual(state.stockpiles, {});
    assert.deepEqual(state.defeatedEnemyIds, []);
    assert.equal(isCampaignCleared(state), false);
  });

  test('campaign-state: 幕は前へだけ進み、現在以下の幕を指定しても状態は変わらない', () => {
    // GAME.md 11.2: 進行は後退しない。
    const state = createCampaignState();
    const act2 = advanceCampaignAct(state, 2);
    assert.equal(act2.act, 2);
    assert.equal(state.act, 1);
    assert.equal(advanceCampaignAct(act2, 1), act2);
    assert.equal(advanceCampaignAct(act2, 2), act2);
  });

  test('campaign-state: 撃破の記録は重複せず、元の状態を書き換えない', () => {
    // GAME.md 11.2: 撃破した敵は二度と戻らない。
    const state = createCampaignState();
    const once = recordEnemyDefeated(state, 'metal-1');
    assert.deepEqual(once.defeatedEnemyIds, ['metal-1']);
    assert.equal(recordEnemyDefeated(once, 'metal-1'), once);
    assert.deepEqual(state.defeatedEnemyIds, []);
  });

  test('campaign-state: 中枢の破壊を記録するとクリアになり、記録は冪等', () => {
    // GAME.md 11.3: クリアは中枢の破壊であり、残敵の全駆逐は条件にしない。
    const state = recordEnemyDefeated(createCampaignState(), 'metal-1');
    const cleared = recordCommandCoreDestroyed(state);
    assert.equal(cleared.commandCore, 'destroyed');
    assert.equal(isCampaignCleared(cleared), true);
    assert.deepEqual(cleared.defeatedEnemyIds, ['metal-1']);
    assert.equal(recordCommandCoreDestroyed(cleared), cleared);
    assert.equal(isCampaignCleared(state), false);
  });

  test('campaign-state: 備蓄は拠点ごとに積み増しと取り出しができ、不足分は取り出せない', () => {
    // GAME.md 11.4: 素材は拠点ごとに備蓄される。
    const state = createCampaignState();
    assert.deepEqual(stockpileOf(state, 'lunar-base'), { materials: 0, propellant: 0 });
    const stocked = addStockpile(state, 'lunar-base', 120, 40);
    assert.deepEqual(stockpileOf(stocked, 'lunar-base'), { materials: 120, propellant: 40 });
    assert.deepEqual(stockpileOf(stocked, 'orbital-yard'), { materials: 0, propellant: 0 });

    const spent = spendStockpile(stocked, 'lunar-base', 20, 40);
    assert.ok(spent !== null);
    assert.deepEqual(stockpileOf(spent, 'lunar-base'), { materials: 100, propellant: 0 });
    assert.equal(spendStockpile(stocked, 'lunar-base', 121, 0), null);
    assert.equal(spendStockpile(stocked, 'lunar-base', 0, 41), null);
    assert.deepEqual(stockpileOf(stocked, 'lunar-base'), { materials: 120, propellant: 40 });
  });

  test('campaign-state: 出来事の適用は素材を備蓄へ積み、幕完了で次の幕へ進める', () => {
    // GAME.md 11.2: デブリの回収は月面基地の備蓄へ加わり、第1幕の完了で第2幕へ進む。
    const state = createCampaignState();
    const next = applyCampaignEvents(state, [
      { kind: 'materialsRecovered', baseId: 'story-lunar-base', materials: 120 },
      { kind: 'storyActCompleted', act: 1 },
    ]);
    assert.deepEqual(stockpileOf(next, 'story-lunar-base'), { materials: 120, propellant: 0 });
    assert.equal(next.act, 2);
    // 完了の記録をもう一度適用しても幕は変わらない。
    assert.equal(applyCampaignEvents(next, [{ kind: 'storyActCompleted', act: 1 }]), next);
  });

  test('campaign-state: 備蓄の増減の出来事は符号つきで適用され、備蓄は負にならない', () => {
    // GAME.md 11.4: 支出・返金・生産は備蓄の増減としてキャンペーンへ同期する。
    const state = createCampaignState();
    const stocked = applyCampaignEvents(state, [
      { kind: 'stockpileChanged', baseId: 'story-lunar-base', materials: 100, propellant: 200 },
    ]);
    assert.deepEqual(stockpileOf(stocked, 'story-lunar-base'), { materials: 100, propellant: 200 });
    const spent = applyCampaignEvents(stocked, [
      { kind: 'stockpileChanged', baseId: 'story-lunar-base', materials: -30, propellant: -50 },
    ]);
    assert.deepEqual(stockpileOf(spent, 'story-lunar-base'), { materials: 70, propellant: 150 });
    // 台帳がずれても備蓄は 0 未満にならない。
    const overdrawn = applyCampaignEvents(spent, [
      { kind: 'stockpileChanged', baseId: 'story-lunar-base', materials: -999, propellant: 0 },
    ]);
    assert.deepEqual(stockpileOf(overdrawn, 'story-lunar-base'), { materials: 0, propellant: 150 });
  });

  test('campaign-state: キャンペーンに関わらない出来事だけでは状態はそのまま返る', () => {
    const state = createCampaignState();
    assert.equal(applyCampaignEvents(state, [{ kind: 'autoWarpStarted' }]), state);
    assert.equal(applyCampaignEvents(state, []), state);
  });

  test('campaign-state: 撃破の出来事は撃破済みとして記録され、造船所の完成も記録される', () => {
    // GAME.md 11.2: 撃破した敵は二度と戻らず、造船所の完成は再入場しても失われない。
    const state = createCampaignState();
    assert.equal(state.shipyardBuilt, false);
    const next = applyCampaignEvents(state, [
      { kind: 'enemyDefeated', enemyId: 'story-act2-enemy-1' },
      { kind: 'enemyDefeated', enemyId: 'story-act2-enemy-1' },
      { kind: 'storyShipyardBuilt' },
    ]);
    assert.deepEqual(next.defeatedEnemyIds, ['story-act2-enemy-1']);
    assert.equal(next.shipyardBuilt, true);
    assert.equal(recordShipyardBuilt(next), next);
    assert.deepEqual(state.defeatedEnemyIds, []);
  });

  test('campaign-state: 評価の集計は出来事で積まれ、撃破の総数は同じ敵を二度数えない', () => {
    // SAVE.md「キャンペーン状態」: 評価の集計はキャンペーンを通しての累計で持つ。
    const state = createCampaignState();
    assert.deepEqual(state.stats, { shipsLost: 0, totalKills: 0, builtMassKg: 0, elapsedSeconds: 0 });
    const next = applyCampaignEvents(state, [
      { kind: 'enemyDefeated', enemyId: 'story-act4-enemy-1' },
      { kind: 'enemyDefeated', enemyId: 'story-act4-enemy-1' },
      { kind: 'enemyDefeated', enemyId: 'story-act3-raid-0-1' },
      { kind: 'storyShipLost' },
      { kind: 'storyConstructionCompleted', massKg: 1200 },
      { kind: 'storyConstructionCompleted', massKg: 300 },
      { kind: 'storyElapsedTime', seconds: 3600 },
      { kind: 'storyElapsedTime', seconds: 1800 },
    ]);
    assert.deepEqual(next.stats, { shipsLost: 1, totalKills: 2, builtMassKg: 1500, elapsedSeconds: 5400 });
    assert.deepEqual(state.stats, { shipsLost: 0, totalKills: 0, builtMassKg: 0, elapsedSeconds: 0 });
  });

  test('campaign-state: 中枢破壊の出来事でクリアになり、集計はそのまま残る', () => {
    // GAME.md 11.3: クリアは中枢の破壊であり、残敵の全駆逐は条件にしない。
    const state = applyCampaignEvents(createCampaignState(), [
      { kind: 'enemyDefeated', enemyId: 'story-act4-enemy-1' },
    ]);
    const cleared = applyCampaignEvents(state, [{ kind: 'commandCoreDestroyed' }]);
    assert.equal(isCampaignCleared(cleared), true);
    assert.equal(cleared.stats.totalKills, 1);
    assert.deepEqual(cleared.defeatedEnemyIds, ['story-act4-enemy-1']);
  });

  test('campaign-state: 第4幕の完了では幕は進まない(クリアは中枢の破壊で決まる)', () => {
    // GAME.md 11.3: 第4幕の決着は幕進行ではなく指揮中枢の破壊である。
    const state = advanceCampaignAct(createCampaignState(), 4);
    assert.equal(applyCampaignEvents(state, [{ kind: 'storyActCompleted', act: 4 }]), state);
  });
}
