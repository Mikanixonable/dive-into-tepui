import * as assert from 'node:assert/strict';
import type { GameInputBinding } from '../../src/game/input/game-actions';
import { gameCommand } from '../../src/game/input/game-commands';
import { GameInputRouter, type RawGameInputAdapter } from '../../src/game/input/game-input-router';
import { test } from '../harness';

class FakeInput implements RawGameInputAdapter {
  public readonly downCodes = new Set<string>();
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

const binding = (code: string): GameInputBinding => ({ code });

export function register(): void {
  test('input router: first enabled command port owns a shared edge', () => {
    const input = new FakeInput();
    input.presses = ['KeyR'];
    const seen: string[] = [];
    const router = new GameInputRouter(input, [
      {
        feature: 'first',
        commands: [gameCommand('first', binding('KeyR'))],
        handleCommand: command => seen.push(command.id),
      },
      {
        feature: 'second',
        commands: [gameCommand('second', binding('KeyR'))],
        handleCommand: command => seen.push(command.id),
      },
    ]);

    router.beginFrame();
    router.route();

    assert.deepEqual(seen, ['first']);
    assert.deepEqual(input.presses, []);
  });

  test('input router: dynamic overlay shortcut keeps unhandled edges for lower ports', () => {
    const input = new FakeInput();
    input.presses = ['KeyH', 'F5'];
    const seen: string[] = [];
    const router = new GameInputRouter(input, [
      {
        feature: 'overlay',
        handlePressed: code => code === 'KeyH',
      },
      {
        feature: 'snapshot',
        commands: [gameCommand('snapshot', binding('F5'))],
        handleCommand: command => seen.push(command.id),
      },
    ]);

    router.beginFrame();
    router.route();

    assert.deepEqual(seen, ['snapshot']);
    assert.deepEqual(input.presses, []);
  });

  test('input router: additional ports use the same frame edge ownership', () => {
    const input = new FakeInput();
    input.presses = ['KeyM'];
    const seen: string[] = [];
    const router = new GameInputRouter(input, [
      {
        feature: 'game',
        commands: [gameCommand('view', binding('KeyM'))],
        handleCommand: command => seen.push(command.id),
      },
    ]);

    router.beginFrame();
    router.route();
    router.routeAdditional([{
      feature: 'external',
      commands: [gameCommand('external', binding('KeyM'))],
      handleCommand: command => seen.push(command.id),
    }]);

    assert.deepEqual(seen, ['view']);
  });

  test('input router: continuous actions claim a shared held code by priority', () => {
    const input = new FakeInput();
    input.downCodes.add('KeyW');
    const seen: string[] = [];
    const router = new GameInputRouter(input, [
      {
        feature: 'first',
        actions: [{ kind: 'continuous', id: 'first', binding: binding('KeyW') }],
        handleAction: action => seen.push(action.id),
      },
      {
        feature: 'second',
        actions: [{ kind: 'continuous', id: 'second', binding: binding('KeyW') }],
        handleAction: action => seen.push(action.id),
      },
    ]);

    router.beginFrame();
    router.route();

    assert.deepEqual(seen, ['first']);
  });
}
