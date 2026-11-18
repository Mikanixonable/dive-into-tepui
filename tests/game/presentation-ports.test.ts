// 提示ポートの面が素の値で組めることと、面へ狭めた受け手がその面だけで動くことを固定する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { CommandQueue } from '../../src/game/command-queue';
import {
  hasUsableConstructionDock, isUsableConstructionDock,
} from '../../src/game/ship/construction-entry';
import { simSpeedCommands } from '../../src/game/dynamic/sim-speed-commands';
import { viewCommands } from '../../src/game/viewer/view-commands';
import type {
  PresentationShip, PresentationShipModule, PresentationSimSpeed, PresentationViewSelection,
} from '../../src/game/presentation-ports';
import { isPresentationEnemy, isPresentationShip } from '../../src/game/presentation-ports';

// 素の部品列から艦の面を組む。
function testShip(modules: readonly PresentationShipModule[], controllable: boolean): PresentationShip {
  return {
    id: 'ship-1',
    capabilities: { controllable },
    assembly: { modules },
  };
}

const DOCK: PresentationShipModule = { id: 'dock-1', kind: 'dock', hp: 1 };
const BROKEN_DOCK: PresentationShipModule = { id: 'dock-2', kind: 'dock', hp: 0 };
const PORT: PresentationShipModule = { id: 'port-1', kind: 'docking_port', hp: 5 };

// 提示ポートの面へ狭めた建造の入口の規則を登録する。
export function register(): void {
  test('presentation-ports: 使用可能な建造ドックは健全な dock だけ', () => {
    assert.equal(isUsableConstructionDock(DOCK), true);
    assert.equal(isUsableConstructionDock(BROKEN_DOCK), false);
    assert.equal(isUsableConstructionDock(PORT), false);
  });

  test('presentation-ports: 建造は操縦できて使用可能なドックがある艦だけ', () => {
    assert.equal(hasUsableConstructionDock(testShip([DOCK], true)), true);
    assert.equal(hasUsableConstructionDock(testShip([DOCK], false)), false);
    assert.equal(hasUsableConstructionDock(testShip([BROKEN_DOCK], true)), false);
    assert.equal(hasUsableConstructionDock(testShip([PORT], true)), false);
    assert.equal(hasUsableConstructionDock(testShip([], true)), false);
  });

  test('presentation-ports: mapKind の艦判定は player/base だけ', () => {
    assert.equal(isPresentationShip({ mapKind: 'player' }), true);
    assert.equal(isPresentationShip({ mapKind: 'base' }), true);
    assert.equal(isPresentationShip({ mapKind: 'enemy' }), false);
    assert.equal(isPresentationShip({ mapKind: 'ammo' }), false);
    assert.equal(isPresentationShip({ mapKind: 'fuel' }), false);
    assert.equal(isPresentationShip({ mapKind: null }), false);
  });

  test('presentation-ports: mapKind の敵判定は enemy だけ', () => {
    assert.equal(isPresentationEnemy({ mapKind: 'enemy' }), true);
    assert.equal(isPresentationEnemy({ mapKind: 'player' }), false);
    assert.equal(isPresentationEnemy({ mapKind: 'base' }), false);
    assert.equal(isPresentationEnemy({ mapKind: null }), false);
  });

  test('presentation-ports: 時間加速の命令は面の管理者へ列で届く', () => {
    const speeds: number[] = [];
    const manager: PresentationSimSpeed = {
      simSpeed: 1,
      estimatedRealSecondsToWarpEnd: () => null,
      remainingSimulationSeconds: () => null,
      setSpeed: (speed) => { speeds.push(speed); },
      shift: () => {},
      startAutoWarpTo: () => false,
      cancelAutoWarp: () => {},
      toggleAutoWarpToFirstNode: () => {},
    };
    const queue = new CommandQueue();
    const commands = simSpeedCommands(queue, manager);
    commands.setSpeed(2);
    assert.deepEqual(speeds, []);

    queue.applyAll();
    assert.deepEqual(speeds, [2]);
  });

  test('presentation-ports: ビュー切替の命令は面の選択へ列で届く', () => {
    const selected: string[] = [];
    let toggled = 0;
    const selection: PresentationViewSelection = {
      select: (view) => { selected.push(view); return true; },
      toggle: () => { toggled += 1; },
    };
    const queue = new CommandQueue();
    const commands = viewCommands(queue, selection);
    commands.select('map');
    commands.toggle();
    assert.deepEqual(selected, []);
    assert.equal(toggled, 0);

    queue.applyAll();
    assert.deepEqual(selected, ['map']);
    assert.equal(toggled, 1);
  });
}
