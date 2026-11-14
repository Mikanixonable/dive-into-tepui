// 建造の規模ゲート: 設備の格ごとの総質量上限と、上限を超える配置が理由つきで
// 拒否されること(GAME.md 11.2)を検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { RunEventLog } from '../../src/game/run-events';
import { StoryEconomy } from '../../src/game/campaign/story-economy';
import {
  ConstructionScaleGate, constructionBranchMassKg,
  CONSTRUCTION_MASS_LIMIT_KG,
} from '../../src/game/campaign/construction-scale-gate';
import { ShipConstructionEdits, type ConstructionShip } from '../../src/game/ship/ship-construction-edits';
import { ShipDockState } from '../../src/game/ship/ship-dock-state';
import {
  buildStoryLunarBaseAssembly, STORY_LUNAR_BASE_ID,
} from '../../src/game/stages/stage-story-lunar';

export function register(): void {
  test('construction-scale-gate: 上限は地表基地・軌道ドック・軌道造船所の順に大きい', () => {
    // GAME.md 11.2: 規模ゲートの上限は設備の格の順に大きい。
    assert.ok(CONSTRUCTION_MASS_LIMIT_KG['surface-base'] < CONSTRUCTION_MASS_LIMIT_KG['orbital-dock']);
    assert.ok(CONSTRUCTION_MASS_LIMIT_KG['orbital-dock'] < CONSTRUCTION_MASS_LIMIT_KG['orbital-shipyard']);
    const gate = new ConstructionScaleGate({ base: 'surface-base', dock: 'orbital-dock' });
    assert.equal(gate.massLimitKgOf('base'), CONSTRUCTION_MASS_LIMIT_KG['surface-base']);
    assert.equal(gate.massLimitKgOf('dock'), CONSTRUCTION_MASS_LIMIT_KG['orbital-dock']);
    assert.equal(gate.massLimitKgOf('unknown'), null);
  });

  test('construction-scale-gate: 超過の理由は上限と完成見込みを含み、収まれば理由は無い', () => {
    const gate = new ConstructionScaleGate({ base: 'surface-base' });
    const limit = CONSTRUCTION_MASS_LIMIT_KG['surface-base'];
    assert.equal(gate.excessReason('base', limit), null);
    assert.equal(gate.excessReason('unknown', limit * 100), null);
    const reason = gate.excessReason('base', limit + 1);
    assert.ok(reason !== null);
    assert.match(reason, new RegExp(`総質量 ${limit} kg`));
    assert.match(reason, /地表基地/);
  });

  test('construction-scale-gate: 月面基地(地表基地)では上限を超える枝を置けず、素材も払わない', () => {
    const { assembly, dockState } = buildStoryLunarBaseAssembly();
    const docks = new ShipDockState(dockState);
    const time = { t: 0 };
    const facade: ConstructionShip = {
      id: STORY_LUNAR_BASE_ID,
      assembly,
      docks,
      capabilities: { controllable: true },
      motion: { alive: true, state: time },
      synchronizeAssemblyState: () => undefined,
    };
    const economy = new StoryEconomy(new RunEventLog(), {
      [STORY_LUNAR_BASE_ID]: { materials: 10_000, propellant: 0 },
    });
    const gate = new ConstructionScaleGate({ [STORY_LUNAR_BASE_ID]: 'surface-base' });
    const edits = new ShipConstructionEdits(facade, 'dock-left', economy, gate);
    // 経済つきの配置は着手であり、完了時刻を過ぎてから取り付けられる(GAME.md 11.4)。
    const completePending = (): void => {
      time.t += 100_000;
      assert.ok(edits.completePending(time.t));
    };
    edits.begin();
    edits.place('thruster-standard', 'axial', 'rocket-thruster');
    completePending();
    // 枝(ロケット)の総質量は地表基地の上限に収まる。
    const rootEdge = assembly.graph.find((edge) => edge.childId === 'rocket-cockpit');
    assert.ok(rootEdge !== undefined);
    const rocketMass = constructionBranchMassKg(assembly, rootEdge.id);
    assert.ok(rocketMass > 0 && rocketMass <= CONSTRUCTION_MASS_LIMIT_KG['surface-base']);

    // ブースター(満載 1,000 kg)を2段足すと枝は 2,960 kg で上限に収まるが、3段目で
    // 上限を超えるため、理由つきで拒否され、船体にも台帳にも残らない。
    edits.place('booster-standard', 'axial', 'rocket-booster-1');
    completePending();
    edits.place('booster-standard', 'axial', 'rocket-booster-2');
    completePending();
    const balanceBefore = economy.stockpileOf(STORY_LUNAR_BASE_ID).materials;
    assert.throws(
      () => edits.place('booster-standard', 'axial', 'rocket-booster-3'),
      /この設備\(地表基地\)では総質量 3000 kg までしか建造できません/,
    );
    assert.equal(assembly.module('rocket-booster-3'), null);
    assert.equal(docks.constructionDraft('dock-left')?.pendingModule, null);
    assert.equal(economy.stockpileOf(STORY_LUNAR_BASE_ID).materials, balanceBefore);
  });

  test('construction-scale-gate: ゲートの無い建造と、対応の無い拠点では上限が働かない', () => {
    const { assembly, dockState } = buildStoryLunarBaseAssembly();
    const docks = new ShipDockState(dockState);
    const facade: ConstructionShip = {
      id: 'unregistered-base',
      assembly,
      docks,
      capabilities: { controllable: true },
      motion: { alive: true, state: { t: 0 } },
      synchronizeAssemblyState: () => undefined,
    };
    const gate = new ConstructionScaleGate({ [STORY_LUNAR_BASE_ID]: 'surface-base' });
    const edits = new ShipConstructionEdits(facade, 'dock-left', null, gate);
    edits.begin();
    edits.place('thruster-standard', 'axial', 'rocket-thruster');
    edits.place('booster-standard', 'axial', 'rocket-booster-1');
    edits.place('booster-standard', 'axial', 'rocket-booster-2');
    edits.place('booster-standard', 'axial', 'rocket-booster-3');
    assert.ok(assembly.module('rocket-booster-3') !== null);
  });
}
