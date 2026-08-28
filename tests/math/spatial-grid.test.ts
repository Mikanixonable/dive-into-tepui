// spatial-grid.ts のテスト。ランダムな点群に対し、27近傍列挙が全数探索(距離 <= セルサイズ)を
// 1つも取りこぼさないこと・同じ要素を二重に返さないことを検証する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { SpatialGrid } from '../../src/math/spatial-grid';
import { v3, Vec3, sub, len } from '../../src/math/vec3';

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

  test('spatial-grid: 半径和だけのセルサイズは掃引経路の途中にいる相手を取りこぼす', () => {
    // 接触検出は各区間の終端位置で登録する(game/simulation/contact.ts と同じ)。
    // a は (0,0,0) → (100,0,0) へ動き、c はその掃引経路の途中(50,0,0)近くに静止している。
    const radius = 1;
    const aEnd = v3(100, 0, 0);
    const move = 100; // aの区間移動量
    const cPos = v3(50, 0, 0);

    const radiusOnlyGrid = new SpatialGrid<string>(2 * radius);
    radiusOnlyGrid.insert('a', aEnd);
    radiusOnlyGrid.insert('c', cPos);
    assert.ok(!radiusOnlyGrid.neighbors(aEnd).includes('c'), '半径和だけのセルサイズでは取りこぼすはずの境界');

    const sweptAwareGrid = new SpatialGrid<string>(2 * (radius + move));
    sweptAwareGrid.insert('a', aEnd);
    sweptAwareGrid.insert('c', cPos);
    assert.ok(sweptAwareGrid.neighbors(aEnd).includes('c'), '半径和+区間移動量の2倍なら取りこぼさない');
  });

  test('spatial-grid: 負の座標をまたぐ近傍も取りこぼさない', () => {
    const rand = mulberry32(3);
    const cellSize = 10;
    // 原点をまたぐよう、セル添字が負になる領域を必ず含む点群を作る。
    const points = randomPoints(rand, 200, 60);
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

  test('spatial-grid: 太陽系スケールの巨大なセル添字でも別セルの要素が混ざらない', () => {
    // 一辺 50 km のセルに 1 AU 級の位置を入れると添字は 1e6〜1e9 に達する。
    const cellSize = 5e4;
    const grid = new SpatialGrid<string>(cellSize);
    const far = v3(1.496e11, -7.31e10, 4.2e10);
    grid.insert('far', far);
    grid.insert('near', v3(0, 0, 0));
    // 各軸を1桁ずつ違う量だけずらした点は、いずれも far のセルから遠く離れている。
    grid.insert('shiftX', v3(far.x + 1e7, far.y, far.z));
    grid.insert('shiftY', v3(far.x, far.y + 1e7, far.z));
    grid.insert('shiftZ', v3(far.x, far.y, far.z + 1e7));

    assert.deepEqual(grid.neighbors(far), ['far']);
    assert.deepEqual(grid.neighbors(v3(0, 0, 0)), ['near']);
  });

  test('spatial-grid: reset 後に前回の要素は残らない', () => {
    const grid = new SpatialGrid<string>(10);
    grid.insert('old', v3(0, 0, 0));
    grid.insert('old2', v3(100, -100, 100));

    grid.reset(10);
    assert.deepEqual(grid.neighbors(v3(0, 0, 0)), []);
    assert.deepEqual(grid.neighbors(v3(100, -100, 100)), []);

    grid.insert('new', v3(0, 0, 0));
    assert.deepEqual(grid.neighbors(v3(0, 0, 0)), ['new']);
    // 使い回した中間構造に前回のセルが残っていないこと。
    assert.deepEqual(grid.neighbors(v3(100, -100, 100)), []);
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
