// hierarchical-spatial-grid.ts のテスト。到達量が桁で異なる要素を混ぜた点群に対し、中心距離が
// 到達量の和以下の全ペアを各1回ずつ列挙することを、全数探索と突き合わせて検証する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { HierarchicalSpatialGrid } from '../../src/math/hierarchical-spatial-grid';
import { mulberry32 } from '../../src/math/random';
import { v3, Vec3, sub, len } from '../../src/math/vec3';

// positions[i] と reaches[i] を要素 i として登録し、列挙されたペアを全数探索と突き合わせる。
// 距離が到達量の和以下のペアを全て含むこと、同じペアを二度返さないこと、自分自身と組まないことを見る。
function assertPairsMatchBruteForce(
  minCellSize: number,
  positions: readonly Vec3[],
  reaches: readonly number[],
): void {
  const grid = new HierarchicalSpatialGrid<number>(minCellSize);
  positions.forEach((p, i) => grid.insert(i, p, reaches[i]!));

  const pairs = grid.pairsInto([]);
  assert.equal(pairs.length % 2, 0, 'ペアが2要素ずつ平らに詰まっていない');

  // 列挙されたペアを順不同の鍵へ畳み、重複と自分自身とのペアを見る。
  const found = new Set<string>();
  for (let k = 0; k < pairs.length; k += 2) {
    const a = pairs[k]!;
    const b = pairs[k + 1]!;
    assert.notEqual(a, b, `要素 ${a} が自分自身とのペアで返っている`);
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    assert.ok(!found.has(key), `ペア ${key} を二度返している`);
    found.add(key);
  }

  // 全数探索で見つかるペアが、その鍵の集合に揃っているかを見る。
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      if (len(sub(positions[j]!, positions[i]!)) <= reaches[i]! + reaches[j]!) {
        assert.ok(found.has(`${i}-${j}`), `距離<=到達量の和 のペア ${i}-${j} が列挙されていない`);
      }
    }
  }
}

export function register(): void {
  test('hierarchical-spatial-grid: 到達量が4桁に散った点群でも全ペアを各1回ずつ返す', () => {
    const rand = mulberry32(1);
    const positions: Vec3[] = [];
    const reaches: number[] = [];
    for (let i = 0; i < 300; i++) {
      positions.push(v3((rand() - 0.5) * 4000, (rand() - 0.5) * 4000, (rand() - 0.5) * 4000));
      // 0.2 m 〜 1 km を対数一様に散らす。
      reaches.push(0.2 * 5000 ** rand());
    }
    assertPairsMatchBruteForce(1, positions, reaches);
  });

  test('hierarchical-spatial-grid: 2段以上離れた段どうしのペアも落ちない', () => {
    // 到達量 0.2 / 8 / 1000 は一辺 1 / 16 / 2048 の段へ分かれ、最小と最大は 11 段離れる。
    const positions = [v3(0, 0, 0), v3(120, 0, 0), v3(-400, 0, 0), v3(0.1, 0, 0), v3(-405, 0, 0)];
    const reaches = [0.2, 8, 1000, 0.2, 8];
    assertPairsMatchBruteForce(1, positions, reaches);
  });

  test('hierarchical-spatial-grid: 負の座標をまたぐペアも落ちない', () => {
    const rand = mulberry32(2);
    const positions: Vec3[] = [];
    const reaches: number[] = [];
    // 原点をまたぐよう、どの段でもセル添字が負になる領域を必ず含む点群を作る。
    for (let i = 0; i < 200; i++) {
      positions.push(v3((rand() - 0.5) * 80, (rand() - 0.5) * 80, (rand() - 0.5) * 80));
      reaches.push(0.5 * 40 ** rand());
    }
    assertPairsMatchBruteForce(1, positions, reaches);
  });

  test('hierarchical-spatial-grid: 到達量が段の一辺の半分ちょうどでもペアを落とさない', () => {
    // 一辺 2^k ちょうどの半分の到達量ばかりを並べ、x 軸上でちょうど接する2体にする
    // (距離と到達量の和が誤差なく一致する)。
    const halfCellSizes = [0.5, 1, 2, 4, 8];
    const positions: Vec3[] = [];
    const reaches: number[] = [];
    let x = 0;
    for (const a of halfCellSizes) {
      for (const b of halfCellSizes) {
        positions.push(v3(x, 0, 0), v3(x + a + b, 0, 0));
        reaches.push(a, b);
        x += 100;
      }
    }
    assertPairsMatchBruteForce(1, positions, reaches);
  });

  test('hierarchical-spatial-grid: reset 後に前回の要素は残らない', () => {
    const grid = new HierarchicalSpatialGrid<string>(1);
    grid.insert('smallOld', v3(0, 0, 0), 0.2);
    grid.insert('hugeOld', v3(300, 0, 0), 1000);
    assert.deepEqual(grid.pairsInto([]), ['smallOld', 'hugeOld']);

    grid.reset();
    assert.deepEqual(grid.pairsInto(['stale']), [], 'out の既存内容ごと空になる');

    grid.insert('smallNew', v3(0, 0, 0), 0.2);
    grid.insert('smallNear', v3(0.1, 0, 0), 0.2);
    assert.deepEqual([...grid.pairsInto([])].sort(), ['smallNear', 'smallNew']);
  });
}
