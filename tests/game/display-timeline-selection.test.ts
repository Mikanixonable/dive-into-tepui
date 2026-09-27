// タイムラインパネルの選択が命令の列で順序どおり変わり、戦闘ビューでは表示時刻が現在へ戻る規則を
// 固定する(INVARIANTS.md §6、ARCHITECTURE R3・R4)。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { CommandQueue } from '../../src/game/command-queue';
import { displayTimelineCommands } from '../../src/game/viewer/display-timeline-commands';
import { DisplayTimelineSelection } from '../../src/game/viewer/display-timeline-selection';
import type { FrameRotationSource, ReferenceFrame } from '../../src/physics/frame';

const inertialFrame: ReferenceFrame = { center: 'earth', rotatingWith: null };
const frames = {
  inertialFrame,
  frameOf(center: string, rotatingWith: FrameRotationSource | null): ReferenceFrame {
    return { center, rotatingWith };
  },
};
const celestialBodies = { has: (id: string) => id === 'earth' || id === 'moon' };

// タイムラインパネルの選択と命令口の回帰テストを登録する。
export function register(): void {
  test('display-timeline-selection: DOM 由来の命令は列の適用まで選択を変えない', () => {
    const selection = DisplayTimelineSelection.create(frames, celestialBodies, undefined);
    const queue = new CommandQueue();
    const commands = displayTimelineCommands(queue, selection);

    commands.setSliderT(0.75);
    commands.selectDuration('day');
    assert.equal(selection.sliderT, 0);
    assert.equal(selection.durationKey, 'orbit');

    queue.applyAll();
    assert.equal(selection.sliderT, 0);
    assert.equal(selection.durationKey, 'day');
    assert.equal(selection.durationSec(123), 86400);
  });

  test('display-timeline-selection: 座標系の命令は受け付けた順に中心と回転を合成する', () => {
    const selection = DisplayTimelineSelection.create(frames, celestialBodies, undefined);
    const queue = new CommandQueue();
    const commands = displayTimelineCommands(queue, selection);
    const rotation: FrameRotationSource = { kind: 'revolution', id: 'moon' };

    commands.setFrameCenter('moon');
    commands.setFrameRotation(rotation);
    queue.applyAll();

    assert.equal(selection.frame.center, 'moon');
    assert.deepEqual(selection.frame.rotatingWith, rotation);
  });

  test('display-timeline-selection: 戦闘ビューの規則はスクラブ位置を現在へ戻す', () => {
    const selection = DisplayTimelineSelection.create(frames, celestialBodies, undefined);
    const queue = new CommandQueue();
    displayTimelineCommands(queue, selection).setSliderT(0.5);
    queue.applyAll();
    selection.followProgress(false);
    assert.equal(selection.sliderT, 0.5);

    selection.followProgress(true);
    assert.equal(selection.sliderT, 0);
  });
}
