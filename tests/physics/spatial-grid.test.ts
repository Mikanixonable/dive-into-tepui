// spatial-grid.ts のテスト。ランダムな点群に対し、27近傍列挙が全数探索(距離 <= セルサイズ)を
// 1つも取りこぼさないこと・同じ要素を二重に返さないことを検証する。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import { SpatialGrid } from '../../src/physics/spatial-grid';
import { v3, Vec3, sub, len } from '../../src/physics/vec3';

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomPoints(rand: () => number, n: number, spread: number): Vec3[] {
  const points: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    points.push(v3((rand() - 0.5) * spread, (rand() - 0.5) * spread, (rand() - 0.5) * spread));
  }
  return points;
}

export function register(): void {
  test('spatial-grid: 27近傍列挙は距離<=セルサイズの全ペアを取りこぼさない', () => {
    const rand = mulberry32(1);
    const cellSize = 10;
    const points = randomPoints(rand, 200, 100);
    const grid = new SpatialGrid<number>(cellSize);
    points.forEach((p, i) => grid.insert(i, p));

    for (let i = 0; i < points.length; i++) {
      const found = new Set(grid.neighbors(points[i]!));
      for (let j = 0; j < points.length; j++) {
        if (i === j) continue;
        if (len(sub(points[j]!, points[i]!)) <= cellSize) {
          assert.ok(found.has(j), `点 ${i} の近傍が点 ${j}(距離<=cellSize)を含んでいない`);
        }
      }
    }
  });

  test('spatial-grid: 27近傍列挙は同じ要素を二重に返さない', () => {
    const rand = mulberry32(2);
    const cellSize = 10;
    const points = randomPoints(rand, 200, 50);
    const grid = new SpatialGrid<number>(cellSize);
    points.forEach((p, i) => grid.insert(i, p));

    for (let i = 0; i < points.length; i++) {
      const found = grid.neighbors(points[i]!);
      assert.equal(found.length, new Set(found).size);
    }
  });
}
