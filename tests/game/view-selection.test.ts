// ビュー選択の復元・遷移条件と、外部命令が進行の位相で適用されることを固定する(R3・R4)。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { CommandQueue } from '../../src/game/command-queue';
import { RunEventLog } from '../../src/game/run-events';
import { viewCommands } from '../../src/game/viewer/view-commands';
import { ViewSelection, type ViewControlSource } from '../../src/game/viewer/view-selection';

interface MutableViewControlSource extends ViewControlSource {
  current: ViewControlSource['current'];
}

// ビュー選択の規則を登録する。
export function register(): void {
  test('view-selection: 戦闘ビューへ入れない復元値はマップへ戻す', () => {
    const events = new RunEventLog();
    const control: MutableViewControlSource = { current: null };
    const selection = new ViewSelection('combat', control, events);

    assert.equal(selection.current, 'map');
    assert.equal(selection.canSelect('combat'), false);
    assert.equal(selection.canSelect('map'), true);
    assert.deepEqual(events.recent, []);
  });

  test('view-selection: 外部命令は列の適用までビューを変えない', () => {
    const events = new RunEventLog();
    const control: MutableViewControlSource = { current: { plan: { nodes: [] } } };
    const selection = new ViewSelection('combat', control, events);
    const queue = new CommandQueue();
    const commands = viewCommands(queue, selection);

    commands.select('map');
    assert.equal(selection.current, 'combat');
    queue.applyAll();
    assert.equal(selection.current, 'map');
    assert.deepEqual(events.recent, []);
  });

  test('view-selection: キー切替の適用結果を進行の出来事へ記録する', () => {
    const events = new RunEventLog();
    const control: MutableViewControlSource = { current: null };
    const selection = new ViewSelection('map', control, events);
    const queue = new CommandQueue();
    const commands = viewCommands(queue, selection);

    commands.toggle();
    queue.applyAll();
    assert.equal(selection.current, 'map');
    assert.deepEqual(events.recent.map((event) => event.body), [{ kind: 'combatViewUnavailable' }]);

    events.beginStep();
    control.current = { plan: { nodes: [{}, {}] } };
    commands.toggle();
    queue.applyAll();
    assert.equal(selection.current, 'combat');
    assert.deepEqual(events.recent.map((event) => event.body), [
      { kind: 'maneuverPlanConfirmed', nodeCount: 2 },
    ]);

    events.beginStep();
    commands.toggle();
    queue.applyAll();
    assert.equal(selection.current, 'map');
    assert.deepEqual(events.recent.map((event) => event.body), [{ kind: 'orbitPlanningOpened' }]);
  });
}
