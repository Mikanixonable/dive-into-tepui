// state-queue.ts のテスト。等速直線運動(r.x = t, v.x = 1)の状態を使うと、エルミート補間が
// 厳密に線形へ一致するため、at() の結果を厳密等値で検証できる。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { StateQueue } from '../../src/physics/state-queue';
import { kinematicState } from '../../src/physics/kinematic-state';
import { v3 } from '../../src/physics/vec3';

function stateAt(t: number) {
  return kinematicState(t, v3(t, 0, 0), v3(1, 0, 0));
}

export function register(): void {
  test('state-queue: push in increasing order interpolates linearly between samples', () => {
    const q = new StateQueue();
    q.push(stateAt(0));
    q.push(stateAt(10));
    q.push(stateAt(20));
    q.push(stateAt(30));
    assert.equal(q.size, 4);
    assert.equal(q.at(15)!.r.x, 15);
    assert.equal(q.at(0)!.r.x, 0);
    assert.equal(q.at(30)!.r.x, 30);
  });

  test('state-queue: at() returns null outside the retained time span', () => {
    const q = new StateQueue();
    q.push(stateAt(0));
    q.push(stateAt(10));
    assert.equal(q.at(-1), null);
    assert.equal(q.at(11), null);
  });

  test('state-queue: at() on an empty or single-sample queue', () => {
    const q = new StateQueue();
    assert.equal(q.at(0), null);
    q.push(stateAt(5));
    assert.equal(q.at(5)!.r.x, 5);
    assert.equal(q.at(6), null);
    assert.equal(q.at(4), null);
  });

  test('state-queue: an out-of-order push discards samples at or after its own time', () => {
    const q = new StateQueue();
    q.push(stateAt(0));
    q.push(stateAt(10));
    q.push(stateAt(20));
    q.push(stateAt(30));
    q.push(stateAt(15)); // 20, 30 はこの push により無効化される
    assert.equal(q.size, 3); // [0, 10, 15]
    assert.equal(q.at(30), null);
    assert.equal(q.at(12)!.r.x, 12);
  });

  test('state-queue: pushing a duplicate timestamp replaces the existing sample', () => {
    const q = new StateQueue();
    q.push(stateAt(0));
    q.push(kinematicState(10, v3(999, 0, 0), v3(0, 0, 0)));
    q.push(stateAt(10)); // 同時刻の再 push は前のものを置き換える
    assert.equal(q.size, 2);
    assert.equal(q.at(10)!.r.x, 10);
  });

  test('state-queue: cleanup drops samples older than maxAge, keeping one boundary sample for at()', () => {
    const q = new StateQueue();
    for (const t of [0, 10, 30, 60, 90]) q.push(stateAt(t));
    q.cleanup(50, 2); // cutoff = 90 - 50 = 40 → 60,90 は cutoff 以上、30 は境界補間用に 1 件だけ残す
    assert.equal(q.size, 3);
    assert.equal(q.at(90)!.r.x, 90);
    assert.equal(q.at(60)!.r.x, 60);
    assert.equal(q.at(30)!.r.x, 30);
    assert.equal(q.at(40)!.r.x, 40); // 30〜60 の補間で cutoff ちょうども引ける
    assert.equal(q.at(10), null); // 30 より古いものは削除済み
  });

  test('state-queue: cleanup(0, ...) keeps only samples at-or-after the newest time', () => {
    const q = new StateQueue();
    for (const t of [0, 10, 30]) q.push(stateAt(t));
    q.cleanup(0, 1); // maxAge=0 は境界補間用の追加保持をしない
    assert.equal(q.size, 1);
    assert.equal(q.at(30)!.r.x, 30);
  });

  test('state-queue: cleanup keeps everything when nothing exceeds maxAge', () => {
    const q = new StateQueue();
    for (const t of [0, 10, 20]) q.push(stateAt(t));
    q.cleanup(1000, 0);
    assert.equal(q.size, 3);
  });

  test('state-queue: toArrayOldestFirst returns samples oldest-to-newest', () => {
    const q = new StateQueue();
    assert.deepEqual(q.toArrayOldestFirst(), []);
    for (const t of [0, 10, 20, 30]) q.push(stateAt(t));
    const arr = q.toArrayOldestFirst();
    assert.deepEqual(arr.map((s) => s.t), [0, 10, 20, 30]);
  });
}
