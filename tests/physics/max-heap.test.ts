// max-heap.ts のテスト。push/pop がスコア最大順を保つこと(ランダムな入出力列・
// 挿入と取り出しの混在に対して参照実装と突き合わせる)、同スコアの扱い、容量境界と
// 空/クリア後のエラー・-Infinity を検証する。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { MaxHeap } from '../../src/math/max-heap';
import { mulberry32 } from '../../src/math/random';

export function register(): void {
  test('max-heap: pop order is non-increasing for a randomized workload, and preserves the multiset of values', () => {
    const rand = mulberry32(1);
    const n = 500;
    const heap = new MaxHeap(n);
    const values: number[] = [];
    for (let i = 0; i < n; i++) {
      const score = (rand() - 0.5) * 1000;
      heap.push(score, i);
      values.push(i);
    }
    assert.equal(heap.size, n);

    const poppedValues: number[] = [];
    let prevScore = Infinity;
    for (let i = 0; i < n; i++) {
      const score = heap.topScore;
      assert.ok(score <= prevScore, `score ${score} exceeds previous ${prevScore}`);
      poppedValues.push(heap.pop());
      prevScore = score;
    }
    assert.equal(heap.size, 0);
    assert.deepEqual(poppedValues.slice().sort((a, b) => a - b), values.slice().sort((a, b) => a - b));
  });

  test('max-heap: interleaved push/pop matches a sorted-array reference model', () => {
    const rand = mulberry32(2);
    const capacity = 300;
    const heap = new MaxHeap(capacity);
    const model: { score: number; value: number }[] = []; // score 降順を保つ参照配列
    let nextValue = 0;

    for (let step = 0; step < 2000; step++) {
      const doPush = model.length === 0 || (model.length < capacity && rand() < 0.6);
      if (doPush) {
        const score = (rand() - 0.5) * 2000;
        const value = nextValue++;
        heap.push(score, value);
        let idx = model.length;
        while (idx > 0 && model[idx - 1]!.score < score) idx--;
        model.splice(idx, 0, { score, value });
      } else {
        assert.equal(heap.topScore, model[0]!.score);
        const popped = heap.pop();
        const expected = model.shift()!;
        assert.equal(popped, expected.value);
      }
      assert.equal(heap.topScore, model.length > 0 ? model[0]!.score : -Infinity);
    }
  });

  test('max-heap: topScore is -Infinity when empty, after popping everything, and after clear()', () => {
    const heap = new MaxHeap(4);
    assert.equal(heap.topScore, -Infinity);

    heap.push(1, 10);
    heap.push(2, 20);
    assert.equal(heap.pop(), 20);
    assert.equal(heap.pop(), 10);
    assert.equal(heap.topScore, -Infinity);

    heap.push(5, 50);
    heap.clear();
    assert.equal(heap.topScore, -Infinity);
  });

  test('max-heap: entries with equal scores all pop before a lower-scored entry (tie order unspecified)', () => {
    const heap = new MaxHeap(5);
    heap.push(10, 100);
    heap.push(10, 101);
    heap.push(10, 102);
    heap.push(5, 50);

    const poppedAtTen = new Set<number>();
    for (let i = 0; i < 3; i++) {
      assert.equal(heap.topScore, 10);
      poppedAtTen.add(heap.pop());
    }
    assert.deepEqual(poppedAtTen, new Set([100, 101, 102]));
    assert.equal(heap.topScore, 5);
    assert.equal(heap.pop(), 50);
  });

  test('max-heap: pushing exactly capacity entries succeeds, one more throws RangeError', () => {
    const capacity = 8;
    const heap = new MaxHeap(capacity);
    assert.equal(heap.capacity, capacity);
    for (let i = 0; i < capacity; i++) heap.push(i, i);
    assert.equal(heap.size, capacity);
    assert.throws(() => heap.push(100, 999), RangeError);
    assert.equal(heap.size, capacity);
  });

  test('max-heap: pop() throws RangeError on an empty heap, an emptied heap, and a cleared heap', () => {
    const fresh = new MaxHeap(3);
    assert.throws(() => fresh.pop(), RangeError);

    const emptied = new MaxHeap(3);
    emptied.push(1, 1);
    emptied.pop();
    assert.throws(() => emptied.pop(), RangeError);

    const cleared = new MaxHeap(3);
    cleared.push(1, 1);
    cleared.clear();
    assert.throws(() => cleared.pop(), RangeError);
  });

  test('max-heap: clear() resets size to 0 and the heap is reusable afterward', () => {
    const heap = new MaxHeap(4);
    heap.push(1, 10);
    heap.push(2, 20);
    heap.clear();
    assert.equal(heap.size, 0);

    heap.push(5, 50);
    heap.push(3, 30);
    heap.push(9, 90);
    assert.equal(heap.size, 3);
    assert.equal(heap.pop(), 90);
    assert.equal(heap.pop(), 50);
    assert.equal(heap.pop(), 30);
    assert.equal(heap.size, 0);
  });

  test('max-heap: a capacity-0 heap starts empty and rejects any push', () => {
    const heap = new MaxHeap(0);
    assert.equal(heap.capacity, 0);
    assert.equal(heap.size, 0);
    assert.equal(heap.topScore, -Infinity);
    assert.throws(() => heap.push(1, 1), RangeError);
  });

  test('max-heap: negative or non-integer capacity throws RangeError from the constructor', () => {
    assert.throws(() => new MaxHeap(-1), RangeError);
    assert.throws(() => new MaxHeap(1.5), RangeError);
    assert.throws(() => new MaxHeap(NaN), RangeError);
  });

  test('max-heap: negative and mixed-sign scores sort correctly', () => {
    const heap = new MaxHeap(6);
    const entries: [number, number][] = [[-5, 1], [3, 2], [-100, 3], [0, 4], [7, 5], [-0.5, 6]];
    for (const [score, value] of entries) heap.push(score, value);

    const expectedOrder = entries.slice().sort((a, b) => b[0] - a[0]).map((e) => e[1]);
    const actualOrder: number[] = [];
    while (heap.size > 0) actualOrder.push(heap.pop());
    assert.deepEqual(actualOrder, expectedOrder);
  });
}
