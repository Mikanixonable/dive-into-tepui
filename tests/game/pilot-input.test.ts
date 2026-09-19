import * as assert from 'node:assert/strict';
import type { GameInputBinding } from '../../src/game/input/game-actions';
import { GameInputRouter, type RawGameInputAdapter } from '../../src/game/input/game-input-router';
import { PilotInput } from '../../src/game/input/pilot-input';
import type { PilotCommand } from '../../src/game/dynamic/dynamic-entity/pilot-controls';
import { test } from '../harness';

// 押下中のキーと、そのフレームの押下エッジを差し替えられる生入力。
class FakeInput implements RawGameInputAdapter {
  public downCodes = new Set<string>();
  public presses: string[] = [];

  public isDown(binding: GameInputBinding): boolean {
    return [binding.code, ...(binding.altCodes ?? [])].some((code) => this.downCodes.has(code));
  }

  public takePressed(binding: GameInputBinding): boolean {
    const index = this.presses.findIndex((code) => [binding.code, ...(binding.altCodes ?? [])].includes(code));
    if (index < 0) return false;
    this.presses.splice(index, 1);
    return true;
  }

  public takePressedCodes(handler: (code: string) => boolean): void {
    for (const code of [...this.presses]) {
      if (!handler(code)) continue;
      const index = this.presses.indexOf(code);
      if (index >= 0) this.presses.splice(index, 1);
    }
  }
}

// 1フレームぶんの入力を流し、そのフレームに出た命令を返す。down を省くと、押下エッジの
// キーだけがそのフレーム押されている。
function frameCommands(
  input: FakeInput, pilot: PilotInput, router: GameInputRouter,
  nowMs: number, presses: readonly string[], shipActs = true, down: readonly string[] = presses,
): readonly PilotCommand[] {
  input.downCodes = new Set(down);
  input.presses = [...presses];
  router.beginFrame();
  pilot.beginFrame(nowMs, shipActs);
  router.route();
  return [...pilot.controls.commands];
}

// 生入力・解釈・配分の3つを、優先順位をひとつだけ持つ状態で組む。
function pilotSetup(): { input: FakeInput; pilot: PilotInput; router: GameInputRouter } {
  const input = new FakeInput();
  const pilot = new PilotInput();
  const router = new GameInputRouter(input, [pilot.actionPort, pilot.commandPort(() => true)]);
  return { input, pilot, router };
}

const LATCH_FORWARD: PilotCommand = { kind: 'thrustLatchToggle', direction: 'forward' };

export function register(): void {
  test('pilot input: 0.3 秒以内の2度押しはその軸のラッチを反転する命令になる', () => {
    const { input, pilot, router } = pilotSetup();

    assert.deepEqual(frameCommands(input, pilot, router, 0, ['KeyW']), []);
    assert.deepEqual(frameCommands(input, pilot, router, 200, ['KeyW']), [LATCH_FORWARD]);
    // 反転のたびに数え直すので、3度目だけでは反転しない。
    assert.deepEqual(frameCommands(input, pilot, router, 400, ['KeyW']), []);
  });

  test('pilot input: 0.3 秒を超えた2度目は連打にならない', () => {
    const { input, pilot, router } = pilotSetup();

    assert.deepEqual(frameCommands(input, pilot, router, 0, ['KeyW']), []);
    assert.deepEqual(frameCommands(input, pilot, router, 400, ['KeyW']), []);
  });

  test('pilot input: 艦が指令を受け付けられない間の押下は連打として数えない', () => {
    const { input, pilot, router } = pilotSetup();

    assert.deepEqual(frameCommands(input, pilot, router, 0, ['KeyW'], false), []);
    // 受け付けられる状態へ戻したフレームで、直前の押下が発火しない。
    assert.deepEqual(frameCommands(input, pilot, router, 100, ['KeyW'], true), []);
    assert.deepEqual(frameCommands(input, pilot, router, 300, ['KeyW'], true), [LATCH_FORWARD]);
  });

  test('pilot input: 緊急停止の同時押しは数えかけの連打を捨てる', () => {
    const { input, pilot, router } = pilotSetup();

    assert.deepEqual(frameCommands(input, pilot, router, 0, ['KeyW']), []);
    // 対向キーを足した瞬間が緊急停止。ここで数え直すので、次の押下は1度目になる。
    assert.deepEqual(frameCommands(input, pilot, router, 100, ['KeyS'], true, ['KeyW', 'KeyS']), []);
    assert.deepEqual(frameCommands(input, pilot, router, 200, ['KeyW']), []);
  });
}
