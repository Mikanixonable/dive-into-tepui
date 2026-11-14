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
import { advanceShipWorks } from '../../src/game/campaign/story-works';
import type { ControlSelection } from '../../src/game/control-selection';
import { ShipAssembly } from '../../src/game/ship/ship-assembly';
import { ShipDockState } from '../../src/game/ship/ship-dock-state';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import { createShipModuleInstance } from '../../src/game/ship/ship-module-instance';
import {
  createBasePreset, createDefaultCombatPreset,
} from '../../src/game/ship/ship-presets';
import { ShipConstructionEdits, type ConstructionShip } from '../../src/game/ship/ship-construction-edits';
import { buildStoryLunarBaseAssembly, STORY_LUNAR_BASE_ID } from '../../src/game/stages/stage-story-lunar';

// 月面基地の開始状態(建造途中のロケットつき)を、経済つきの建造編集へ渡す。
// time は船のシミュレーション時刻の代役で、テストが進めて完了を駆動する。
function lunarEdits(economy: StoryEconomy | null): {
  edits: ShipConstructionEdits; assembly: ShipAssembly; docks: ShipDockState; time: { t: number };
} {
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
  return { edits: new ShipConstructionEdits(facade, 'dock-left', economy), assembly, docks, time };
}

// 基地へ別船体が接続した状態の assembly。修理と製造はこの形で使う。
function connectedAssembly(): ShipAssembly {
  const host = createBasePreset();
  const guest = new ShipAssembly(SHIP_MODULE_CATALOG, true);
  guest.addRoot(createShipModuleInstance(SHIP_MODULE_CATALOG.require('docking-port-standard'), 'port'));
  return host.mergedAtDock(guest, 'dock-left', 'port', 'guest').assembly;
}

// ModuleCommands の対象の代役。修理と補給の呼び出しだけを記録する。修理の
// 進行(advanceShipWorks)へ渡せるよう、建造編集の対象の面も持つ。
class FakeTarget implements ModuleCommandTarget {
  public readonly id = 'test-base';
  public readonly docks = new ShipDockState();
  public readonly time = { t: 0 };
  public readonly motion = { alive: true, state: this.time };
  public readonly capabilities = { selectOperatingCockpit: () => true, controllable: true };
  public repairedWith: string | null = null;
  public failRepair = false;
  public pickedUpMags = 0;

  public constructor(public readonly assembly: ShipAssembly) {}

  public setModuleDeployment(): void {}
  public toggleBoosterIgnition(): boolean { return false; }
  public decouple(): void {}
  public undock(): void {}
  public synchronizeAssemblyState(): void {}
  public repairAtDock(moduleId: string): void {
    if (this.failRepair) throw new Error(`docking module is not connected: ${moduleId}`);
    this.repairedWith = moduleId;
  }
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
    const { edits, assembly, time } = lunarEdits(economy);
    edits.begin();
    edits.place('thruster-standard', 'axial', 'rocket-thruster');
    assert.equal(economy.stockpileOf(STORY_LUNAR_BASE_ID).materials, 100 - thrusterCost);
    // 着手の時点では、部品はまだ船体の一部になっていない(GAME.md 11.4)。
    assert.equal(assembly.module('rocket-thruster'), null);
    // 完了時刻(推進器は乾燥質量 50 kg で 50 秒)が来るまでは取り付けられず、
    // 来れば取り付けられる。
    assert.equal(edits.completePending(time.t + 49), false);
    assert.equal(assembly.module('rocket-thruster'), null);
    time.t += 50;
    assert.equal(edits.completePending(time.t), true);
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
    assert.equal(poorRun.docks.constructionDraft('dock-left')?.pendingModule, null);
  });

  test('story-economy wiring: 建造途中の取り外しと破棄は素材を備蓄へ戻す', () => {
    const economy = new StoryEconomy(new RunEventLog(), {
      [STORY_LUNAR_BASE_ID]: { materials: 100, propellant: 0 },
    });
    const { edits, time } = lunarEdits(economy);
    edits.begin();
    // 建造中の部品の取り外しは着手の取り消しで、素材が戻る。
    edits.place('thruster-standard', 'axial', 'rocket-thruster');
    edits.removeLast();
    assert.equal(economy.stockpileOf(STORY_LUNAR_BASE_ID).materials, 100);

    // 完成済みの部品と建造中の部品が混ざった破棄でも、支払った分は全て戻る。
    edits.place('thruster-standard', 'axial', 'rocket-thruster');
    time.t += 50;
    assert.equal(edits.completePending(time.t), true);
    edits.place('tank-3-main', 'axial', 'rocket-spare-tank');
    edits.discard();
    assert.equal(economy.stockpileOf(STORY_LUNAR_BASE_ID).materials, 100);

    // 開始状態からある無償の部品は、破棄しても素材にならない。
    const untouched = lunarEdits(economy);
    untouched.edits.begin();
    untouched.edits.discard();
    assert.equal(economy.stockpileOf(STORY_LUNAR_BASE_ID).materials, 100);
  });

  test('story-economy wiring: 修理は着手で素材を払い、完了時刻に適用され、不足なら着手できない', () => {
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
    assert.equal(poorTarget.docks.pendingRepair('dock-left'), null);
    assert.equal(poor.stockpileOf('test-base').materials, cost - 1);

    const rich = new StoryEconomy(new RunEventLog(), { 'test-base': { materials: cost, propellant: 0 } });
    const richTarget = new FakeTarget(assembly);
    const richRun = commandsWith(rich, richTarget);
    const succeeded = runCommand(richRun.commands, richTarget, 'dock-left', 'repairDockedModules', richRun.queue);
    assert.equal(succeeded.state.kind, 'succeeded');
    // 着手では素材だけが動き、修理はまだ適用されない(GAME.md 11.4)。
    assert.equal(richTarget.repairedWith, null);
    assert.equal(rich.stockpileOf('test-base').materials, 0);
    const pending = richTarget.docks.pendingRepair('dock-left');
    assert.ok(pending !== null);
    assert.equal(pending.materials, cost);
    // 修理中の二重の着手は、残り時間を示して拒否される。
    const duplicate = runCommand(richRun.commands, richTarget, 'dock-left', 'repairDockedModules', richRun.queue);
    assert.equal(duplicate.state.kind, 'failed');
    // 完了時刻より前は適用されず、来れば作業の進行が修理を適用する。
    advanceShipWorks(richTarget, pending.completesAt - 1, rich);
    assert.equal(richTarget.repairedWith, null);
    advanceShipWorks(richTarget, pending.completesAt, rich);
    assert.equal(richTarget.repairedWith, 'dock-left');
    assert.equal(richTarget.docks.pendingRepair('dock-left'), null);

    // 完了時点で修理の条件を失っていれば、修理は行われず素材が戻る。
    const refundEconomy = new StoryEconomy(new RunEventLog(), {
      'test-base': { materials: cost, propellant: 0 },
    });
    const refundTarget = new FakeTarget(assembly);
    refundTarget.failRepair = true;
    const refundRun = commandsWith(refundEconomy, refundTarget);
    const begun = runCommand(refundRun.commands, refundTarget, 'dock-left', 'repairDockedModules', refundRun.queue);
    assert.equal(begun.state.kind, 'succeeded');
    assert.equal(refundEconomy.stockpileOf('test-base').materials, 0);
    const refundPending = refundTarget.docks.pendingRepair('dock-left');
    assert.ok(refundPending !== null);
    advanceShipWorks(refundTarget, refundPending.completesAt, refundEconomy);
    assert.equal(refundTarget.repairedWith, null);
    assert.equal(refundEconomy.stockpileOf('test-base').materials, cost);
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

  test('story-economy wiring: 推進剤補給は主推進の残りで RCS タンクも満たす', () => {
    const assembly = createBasePreset();
    assembly.consumeFuel('main', 100);
    assembly.consumeFuel('rcs', 30);
    const mainBefore = assembly.totals().mainFuel;
    const rcsBefore = assembly.totals().rcsFuel;
    const economy = new StoryEconomy(new RunEventLog(), {
      'test-base': { materials: 0, propellant: 120 },
    });
    const target = new FakeTarget(assembly);
    const run = commandsWith(economy, target);
    const completion = runCommand(run.commands, target, 'dock-left', 'refuelFromStockpile', run.queue);
    assert.equal(completion.state.kind, 'succeeded');
    // 主推進(1 kg/unit)の空き 100 が先に埋まり、残り 20 kg で RCS が
    // 1 kg/unit の換算で 20 unit 埋まる(GAME.md 11.4)。
    assert.equal(assembly.totals().mainFuel - mainBefore, 100);
    assert.equal(assembly.totals().rcsFuel - rcsBefore, 20);
    assert.equal(economy.stockpileOf('test-base').propellant, 0);
  });

  test('story-economy wiring: 戦闘 RCS タンク(単位質量 0)も換算で会計に載る', () => {
    const assembly = createDefaultCombatPreset();
    assembly.consumeFuel('rcs', 80);
    const mainBefore = assembly.totals().mainFuel;
    const rcsBefore = assembly.totals().rcsFuel;
    const economy = new StoryEconomy(new RunEventLog(), {
      'test-base': { materials: 0, propellant: 50 },
    });
    const target = new FakeTarget(assembly);
    const run = commandsWith(economy, target);
    const completion = runCommand(run.commands, target, 'rcs-tank', 'refuelFromStockpile', run.queue);
    assert.equal(completion.state.kind, 'succeeded');
    // 戦闘 RCS タンクの単位質量は 0 だが、補給した 50 unit は 1 kg/unit の
    // 換算で備蓄から引かれる。満杯の主推進タンクは動かない。
    assert.equal(assembly.totals().rcsFuel - rcsBefore, 50);
    assert.equal(assembly.totals().mainFuel, mainBefore);
    assert.equal(economy.stockpileOf('test-base').propellant, 0);
  });
}
