// 経済の配線: 建造・修理・マガジン製造・推進剤補給が備蓄を消費し、不足時に
// 理由つきで拒否されること(GAME.md 11.4)を検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { CommandQueue } from '../../src/game/command-queue';
import { CommandCompletion } from '../../src/game/command-completion';
import { RunEventLog } from '../../src/game/run-events';
import {
  StoryEconomy, MAGAZINE_MATERIALS, moduleMaterialsCost, repairMaterialsCost,
} from '../../src/game/campaign/story-economy';
import {
  ModuleCommands, type ModuleCommandTarget, type ModuleCommandRoster,
} from '../../src/game/pickable/module-commands';
import type { ControlSelection } from '../../src/game/control-selection';
import { ShipAssembly } from '../../src/game/ship/ship-assembly';
import { ShipDockState } from '../../src/game/ship/ship-dock-state';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import { createShipModuleInstance } from '../../src/game/ship/ship-module-instance';
import { createBasePreset } from '../../src/game/ship/ship-presets';
import { ShipConstructionEdits, type ConstructionShip } from '../../src/game/ship/ship-construction-edits';
import { buildStoryLunarBaseAssembly, STORY_LUNAR_BASE_ID } from '../../src/game/stages/stage-story-lunar';

// 月面基地の開始状態(建造途中のロケットつき)を、経済つきの建造編集へ渡す。
function lunarEdits(economy: StoryEconomy | null): {
  edits: ShipConstructionEdits; assembly: ShipAssembly; docks: ShipDockState;
} {
  const { assembly, dockState } = buildStoryLunarBaseAssembly();
  const docks = new ShipDockState(dockState);
  const facade: ConstructionShip = {
    id: STORY_LUNAR_BASE_ID,
    assembly,
    docks,
    capabilities: { controllable: true },
    motion: { alive: true },
    synchronizeAssemblyState: () => undefined,
  };
  return { edits: new ShipConstructionEdits(facade, 'dock-left', economy), assembly, docks };
}

// 基地へ別船体が接続した状態の assembly。修理と製造はこの形で使う。
function connectedAssembly(): ShipAssembly {
  const host = createBasePreset();
  const guest = new ShipAssembly(SHIP_MODULE_CATALOG, true);
  guest.addRoot(createShipModuleInstance(SHIP_MODULE_CATALOG.require('docking-port-standard'), 'port'));
  return host.mergedAtDock(guest, 'dock-left', 'port', 'guest').assembly;
}

// ModuleCommands の対象の代役。修理と補給の呼び出しだけを記録する。
class FakeTarget implements ModuleCommandTarget {
  public readonly id = 'test-base';
  public readonly motion = { alive: true };
  public readonly capabilities = { selectOperatingCockpit: () => true };
  public repairedWith: string | null = null;
  public pickedUpMags = 0;

  public constructor(public readonly assembly: ShipAssembly) {}

  public setModuleDeployment(): void {}
  public toggleBoosterIgnition(): boolean { return false; }
  public decouple(): void {}
  public undock(): void {}
  public repairAtDock(moduleId: string): void { this.repairedWith = moduleId; }
  public onPickup(mags: number): void { this.pickedUpMags += mags; }
}

// 命令を1件受け付けて即時に適用し、応答を返す。
function runCommand(
  commands: ModuleCommands, target: ModuleCommandTarget, moduleId: string,
  action: 'repairDockedModules' | 'manufactureMagazine' | 'refuelFromStockpile',
  queue: CommandQueue,
): CommandCompletion {
  const completion = new CommandCompletion();
  commands.submit(target, moduleId, action, completion);
  queue.applyAll();
  return completion;
}

function commandsWith(economy: StoryEconomy | null, target: ModuleCommandTarget): {
  commands: ModuleCommands; queue: CommandQueue;
} {
  const queue = new CommandQueue();
  const roster = { all: () => [target] } as unknown as ModuleCommandRoster;
  const selection = null as unknown as ControlSelection;
  return { commands: new ModuleCommands(queue, selection, roster, economy), queue };
}

export function register(): void {
  test('story-economy wiring: 建造は備蓄から素材を払い、不足なら部品を置かず理由を返す', () => {
    const thrusterCost = moduleMaterialsCost(SHIP_MODULE_CATALOG.require('thruster-standard'));
    const economy = new StoryEconomy(new RunEventLog(), {
      [STORY_LUNAR_BASE_ID]: { materials: 100, propellant: 0 },
    });
    const { edits, assembly } = lunarEdits(economy);
    edits.begin();
    edits.place('thruster-standard', 'axial', 'rocket-thruster');
    assert.equal(economy.stockpileOf(STORY_LUNAR_BASE_ID).materials, 100 - thrusterCost);
    assert.ok(assembly.module('rocket-thruster') !== null);

    // 備蓄 5 では推進器(12)は置けず、船体も台帳も変わらない。
    const poor = new StoryEconomy(new RunEventLog(), {
      [STORY_LUNAR_BASE_ID]: { materials: 5, propellant: 0 },
    });
    const poorRun = lunarEdits(poor);
    poorRun.edits.begin();
    assert.throws(
      () => poorRun.edits.place('thruster-standard', 'axial', 'rocket-thruster'),
      /素材が不足しています\(必要 12 \/ 備蓄 5 — あと 7\)/,
    );
    assert.equal(poorRun.assembly.module('rocket-thruster'), null);
    assert.equal(poor.stockpileOf(STORY_LUNAR_BASE_ID).materials, 5);
    assert.deepEqual(poorRun.docks.constructionDraft('dock-left')?.addedIds.length, 8);
  });

  test('story-economy wiring: 建造途中の取り外しと破棄は素材を備蓄へ戻す', () => {
    const economy = new StoryEconomy(new RunEventLog(), {
      [STORY_LUNAR_BASE_ID]: { materials: 100, propellant: 0 },
    });
    const { edits } = lunarEdits(economy);
    edits.begin();
    edits.place('thruster-standard', 'axial', 'rocket-thruster');
    edits.removeLast();
    assert.equal(economy.stockpileOf(STORY_LUNAR_BASE_ID).materials, 100);

    edits.place('thruster-standard', 'axial', 'rocket-thruster');
    edits.place('tank-3-main', 'axial', 'rocket-spare-tank');
    edits.discard();
    assert.equal(economy.stockpileOf(STORY_LUNAR_BASE_ID).materials, 100);

    // 開始状態からある無償の部品は、破棄しても素材にならない。
    const untouched = lunarEdits(economy);
    untouched.edits.begin();
    untouched.edits.discard();
    assert.equal(economy.stockpileOf(STORY_LUNAR_BASE_ID).materials, 100);
  });

  test('story-economy wiring: 修理は素材を払い、不足なら修理しない', () => {
    const assembly = connectedAssembly();
    const damagedId = assembly.moduleIds.find((id) => id !== 'dock-left')!;
    assembly.setHp(damagedId, 10);
    const cost = repairMaterialsCost(assembly);
    assert.ok(cost > 0);

    const poor = new StoryEconomy(new RunEventLog(), { 'test-base': { materials: cost - 1, propellant: 0 } });
    const poorTarget = new FakeTarget(assembly);
    const poorRun = commandsWith(poor, poorTarget);
    const failed = runCommand(poorRun.commands, poorTarget, 'dock-left', 'repairDockedModules', poorRun.queue);
    assert.equal(failed.state.kind, 'failed');
    assert.equal(poorTarget.repairedWith, null);
    assert.equal(poor.stockpileOf('test-base').materials, cost - 1);

    const rich = new StoryEconomy(new RunEventLog(), { 'test-base': { materials: cost, propellant: 0 } });
    const richTarget = new FakeTarget(assembly);
    const richRun = commandsWith(rich, richTarget);
    const succeeded = runCommand(richRun.commands, richTarget, 'dock-left', 'repairDockedModules', richRun.queue);
    assert.equal(succeeded.state.kind, 'succeeded');
    assert.equal(richTarget.repairedWith, 'dock-left');
    assert.equal(rich.stockpileOf('test-base').materials, 0);
  });

  test('story-economy wiring: マガジン製造は素材を払ってベルトへ足し、経済が無ければできない', () => {
    const assembly = connectedAssembly();
    const economy = new StoryEconomy(new RunEventLog(), {
      'test-base': { materials: MAGAZINE_MATERIALS, propellant: 0 },
    });
    const target = new FakeTarget(assembly);
    const run = commandsWith(economy, target);
    const completion = runCommand(run.commands, target, 'dock-left', 'manufactureMagazine', run.queue);
    assert.equal(completion.state.kind, 'succeeded');
    assert.equal(target.pickedUpMags, 1);
    assert.equal(economy.stockpileOf('test-base').materials, 0);

    const noEconomyTarget = new FakeTarget(assembly);
    const noEconomyRun = commandsWith(null, noEconomyTarget);
    const rejected = runCommand(
      noEconomyRun.commands, noEconomyTarget, 'dock-left', 'manufactureMagazine', noEconomyRun.queue,
    );
    assert.equal(rejected.state.kind, 'failed');
    assert.equal(noEconomyTarget.pickedUpMags, 0);
  });

  test('story-economy wiring: 推進剤補給は備蓄から引き、備蓄が尽きたら給油できない', () => {
    const assembly = createBasePreset();
    assembly.consumeFuel('main', 400);
    const before = assembly.totals().mainFuel;
    const economy = new StoryEconomy(new RunEventLog(), {
      'test-base': { materials: 0, propellant: 200 },
    });
    const target = new FakeTarget(assembly);
    const run = commandsWith(economy, target);
    const completion = runCommand(run.commands, target, 'dock-left', 'refuelFromStockpile', run.queue);
    assert.equal(completion.state.kind, 'succeeded');
    // 基地 preset の主タンクは容量 160 unit・1 kg/unit: 空き 160 が埋まり、
    // 引かれるのは移した 160 kg だけ(残りは備蓄に残る)。
    assert.equal(assembly.totals().mainFuel - before, 160);
    assert.equal(economy.stockpileOf('test-base').propellant, 40);

    // タンクが満タンなら、それ以上は移らない。
    const again = runCommand(run.commands, target, 'dock-left', 'refuelFromStockpile', run.queue);
    assert.equal(again.state.kind, 'failed');
  });
}
