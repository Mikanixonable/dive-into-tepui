// モデル層の外から届いた命令の列が、受け付けた順に1度だけ適用されることを検査する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { CommandQueue } from '../../src/game/command-queue';

export function register(): void {
  test('command-queue: 命令は受け付けた時点では効かず、適用で受け付けた順に1度だけ効く', () => {
    // CODING-RULE R3: 命令は受け付けた時点では状態を変えず、次の進行の位相の先頭で受け付けた順に適用する
    const queue = new CommandQueue();
    const applied: string[] = [];
    queue.submit(() => applied.push('a'));
    queue.submit(() => applied.push('b'));
    assert.deepEqual(applied, []);

    queue.applyAll();
    assert.deepEqual(applied, ['a', 'b']);
    queue.applyAll();
    assert.deepEqual(applied, ['a', 'b']);
  });

  test('command-queue: 適用の途中で積まれた命令は、次の適用へ回る', () => {
    // CODING-RULE R3: 受け付けた命令は、次の進行の位相の先頭で適用する
    const queue = new CommandQueue();
    const applied: string[] = [];
    queue.submit(() => {
      applied.push('outer');
      queue.submit(() => applied.push('inner'));
    });

    queue.applyAll();
    assert.deepEqual(applied, ['outer']);
    queue.applyAll();
    assert.deepEqual(applied, ['outer', 'inner']);
  });
}
