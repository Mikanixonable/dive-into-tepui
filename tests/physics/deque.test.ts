// deque.ts のテスト。両端からの push/pop の順序、容量拡張をまたいだ要素の保持、
// リングバッファのインデックス折り返し、範囲外アクセスのエラーを検証する。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { Deque } from '../../src/physics/deque';

export function register(): void {
  test('deque: pushRight/popLeft is FIFO', () => {
    const d = new Deque<number>();
    d.pushRight(1);
    d.pushRight(2);
    d.pushRight(3);
    assert.equal(d.size, 3);
    assert.equal(d.popLeft(), 1);
    assert.equal(d.popLeft(), 2);
    assert.equal(d.popLeft(), 3);
    assert.ok(d.empty);
  });

  test('deque: pushLeft/popRight is FIFO from the other end', () => {
    const d = new Deque<number>();
    d.pushLeft(1);
    d.pushLeft(2);
    d.pushLeft(3);
    assert.equal(d.popRight(), 1);
    assert.equal(d.popRight(), 2);
    assert.equal(d.popRight(), 3);
  });

  test('deque: pushLeft/pushRight combined ordering', () => {
    const d = new Deque<number>();
    d.pushRight(1); // [1]
    d.pushLeft(0);  // [0,1]
    d.pushRight(2); // [0,1,2]
    assert.deepEqual([d.at(0), d.at(1), d.at(2)], [0, 1, 2]);
    assert.equal(d.peekLeft(), 0);
    assert.equal(d.peekRight(), 2);
  });

  test('deque: at() throws RangeError out of range', () => {
    const d = new Deque<number>();
    d.pushRight(1);
    assert.throws(() => d.at(-1), RangeError);
    assert.throws(() => d.at(1), RangeError);
  });

  test('deque: popLeft/popRight throw on empty', () => {
    const d = new Deque<number>();
    assert.throws(() => d.popLeft(), RangeError);
    assert.throws(() => d.popRight(), RangeError);
  });

  test('deque: capacity grows beyond the initial size while preserving order', () => {
    const d = new Deque<number>(4);
    for (let i = 0; i < 100; i++) d.pushRight(i);
    assert.equal(d.size, 100);
    for (let i = 0; i < 100; i++) assert.equal(d.at(i), i);
  });

  test('deque: ring index wraps around after push/pop cycling', () => {
    const d = new Deque<number>(4);
    // 詰めて抜いてを繰り返し、start がバッファ末尾を越えて折り返す状態を作る
    for (let i = 0; i < 3; i++) d.pushRight(i);
    for (let i = 0; i < 3; i++) d.popLeft();
    for (let i = 10; i < 20; i++) d.pushRight(i);
    assert.equal(d.size, 10);
    for (let i = 0; i < 10; i++) assert.equal(d.at(i), 10 + i);
  });

  test('deque: deleteLeftN/deleteRightN trim each end', () => {
    const d = new Deque<number>();
    for (let i = 0; i < 5; i++) d.pushRight(i); // [0,1,2,3,4]
    d.deleteLeftN(2); // [2,3,4]
    assert.equal(d.size, 3);
    assert.equal(d.peekLeft(), 2);
    d.deleteRightN(1); // [2,3]
    assert.equal(d.size, 2);
    assert.equal(d.peekRight(), 3);
  });

  test('deque: deleteLeftN/deleteRightN reject out-of-range counts', () => {
    const d = new Deque<number>();
    d.pushRight(1);
    assert.throws(() => d.deleteLeftN(-1), RangeError);
    assert.throws(() => d.deleteLeftN(2), RangeError);
    assert.throws(() => d.deleteRightN(2), RangeError);
  });

  test('deque: clear empties the deque and it stays usable afterward', () => {
    const d = new Deque<number>();
    for (let i = 0; i < 5; i++) d.pushRight(i);
    d.clear();
    assert.ok(d.empty);
    assert.equal(d.size, 0);
    assert.throws(() => d.popLeft(), RangeError);
    d.pushRight(42);
    assert.equal(d.peekLeft(), 42);
  });
}
