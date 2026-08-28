// zero-velocity.ts の回帰テスト。ヤコビ定数の閉じた式・停留点性・ネックが開閉する順序・
// 曲線上の点が f=0 を満たすことを、地球-月/太陽-地球の質量比で確かめる。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  pseudoPotential, lagrangeJacobi, zeroVelocityCurves, LagrangeLabel,
} from '../../src/physics/zero-velocity';

// 検算用の質量比。地球-月は非対称性(mu が小さくない)、太陽-地球は極端に小さい mu を持つので
// 両方でネックの開閉順序や停留点の判定が崩れないことを確かめる。
const MU_EARTH_MOON = 0.012150585609624;
const MU_SUN_EARTH = 3.003480578941791e-6;

// tests/run.ts から呼ばれ、このファイルのテストケースを harness へ登録する。
export function register(): void {
  for (const mu of [MU_EARTH_MOON, MU_SUN_EARTH]) {
    test(`zero-velocity: lagrangeJacobi(L4) matches the closed form (mu=${mu})`, () => {
      const expected = 3 - mu + mu * mu;
      assert.ok(Math.abs(lagrangeJacobi(mu, 'L4') - expected) < 1e-12);
      assert.ok(Math.abs(lagrangeJacobi(mu, 'L5') - expected) < 1e-12);
    });

    test(`zero-velocity: C(L1) > C(L2) > C(L3) > C(L4) (mu=${mu})`, () => {
      const c1 = lagrangeJacobi(mu, 'L1');
      const c2 = lagrangeJacobi(mu, 'L2');
      const c3 = lagrangeJacobi(mu, 'L3');
      const c4 = lagrangeJacobi(mu, 'L4');
      assert.ok(c1 > c2, `C(L1)=${c1} should exceed C(L2)=${c2}`);
      assert.ok(c2 > c3, `C(L2)=${c2} should exceed C(L3)=${c3}`);
      assert.ok(c3 > c4, `C(L3)=${c3} should exceed C(L4)=${c4}`);
    });

    test(`zero-velocity: pseudoPotential gradient vanishes at the Lagrange points (mu=${mu})`, () => {
      const positions = lagrangePositions(mu);
      const h = 1e-6;
      for (const [label, [x, y, z]] of Object.entries(positions) as [LagrangeLabel, [number, number, number]][]) {
        const grad = numericalGradient(mu, x, y, z, h);
        // 停留点なので勾配は0。刻み幅 h の丸めに合わせた許容で判定する。
        assert.ok(Math.abs(grad[0]) < 1e-4, `${label}: dΩ/dx=${grad[0]}`);
        assert.ok(Math.abs(grad[1]) < 1e-4, `${label}: dΩ/dy=${grad[1]}`);
        assert.ok(Math.abs(grad[2]) < 1e-4, `${label}: dΩ/dz=${grad[2]}`);
      }
    });

    test(`zero-velocity: neck at L1 separates then merges the primary/secondary lobes (mu=${mu})`, () => {
      const c1 = lagrangeJacobi(mu, 'L1');
      const half = 1.6;
      const resolution = 400;
      const primary: [number, number] = [-mu, 0];
      const secondary: [number, number] = [1 - mu, 0];
      // C(L1) からのずれ。太陽-地球のように mu が極小だと C(L1)〜C(L4) が互いに詰まっているため、
      // 0.01 では L4/L5 側の禁止領域まで一緒に消えてしまう。ネック1つぶんの開閉だけを見たいので、
      // 十分小さいずれ幅を使う。
      const delta = 1e-4;

      // C を C(L1) よりわずかに大きく取ると、まだネックが閉じていて主天体・副天体は
      // それぞれを囲む最小の閉曲線が別々になる。
      const closed = zeroVelocityCurves(mu, c1 + delta, 'xy', half, resolution);
      assert.notEqual(
        minimalEnclosingLoop(closed, primary), minimalEnclosingLoop(closed, secondary),
        'expected separate enclosing loops for each body just above C(L1)',
      );

      // C を C(L1) よりわずかに小さく取るとネックが開き、主天体・副天体を囲む最小の閉曲線が
      // 同一になる(あるいは、より外側まで完全に繋がって、どちらも閉曲線に囲まれなくなる)。
      const open = zeroVelocityCurves(mu, c1 - delta, 'xy', half, resolution);
      assert.equal(
        minimalEnclosingLoop(open, primary), minimalEnclosingLoop(open, secondary),
        'expected the same enclosing loop for both bodies just below C(L1)',
      );
    });

    test(`zero-velocity: curve points satisfy 2*Omega - C ~= 0 (mu=${mu})`, () => {
      const c1 = lagrangeJacobi(mu, 'L1');
      const half = 1.6;
      const resolution = 400;
      const jacobi = c1 + 1e-4;
      const curves = zeroVelocityCurves(mu, jacobi, 'xy', half, resolution);
      assert.ok(curves.length > 0, 'expected at least one curve component');
      // 線形補間の誤差は格子幅程度に収まるはずなので、格子幅を基準にした許容を取る。
      const step = half / resolution;
      const tolerance = step * 5;
      for (const curve of curves) {
        for (const [x, y] of curve) {
          const residual = 2 * pseudoPotential(mu, x, y, 0) - jacobi;
          assert.ok(Math.abs(residual) < tolerance, `residual ${residual} at (${x},${y})`);
        }
      }
    });
  }
}

// mu から xy 断面(z=0)上のラグランジュ点の位置を求める(共線点は既知の x 軸上、三角点は
// 正三角配置)。L1〜L3 は lagrangeJacobi の依存先(collinearGamma)を経由せず、
// pseudoPotential の停留点を独立に Newton 法で解き直す(判定対象と根拠を分離するため)。
function lagrangePositions(mu: number): Record<LagrangeLabel, [number, number, number]> {
  const s60 = Math.sqrt(3) / 2;
  return {
    L1: collinearPosition(mu, 'L1'),
    L2: collinearPosition(mu, 'L2'),
    L3: collinearPosition(mu, 'L3'),
    L4: [0.5 - mu, s60, 0],
    L5: [0.5 - mu, -s60, 0],
  };
}

// L1〜L3 の x 座標を、pseudoPotential が dΩ/dx=0 になる点として1次元 Newton 法で求める
// (lagrange.ts の collinearGamma と同じ答えになるはずの独立実装で、勾配ゼロ判定の
// テストを collinearGamma 自身の正しさに依存させないため)。
function collinearPosition(mu: number, point: 'L1' | 'L2' | 'L3'): [number, number, number] {
  const seed = point === 'L1' ? 1 - Math.cbrt(mu / 3)
    : point === 'L2' ? 1 + Math.cbrt(mu / 3)
    : -1 + (7 / 12) * mu;
  let x = seed;
  const h = 1e-6;
  // 中心差分の1階・2階微分から Newton 法の更新量を作る。
  for (let i = 0; i < 100; i++) {
    const d1 = (pseudoPotential(mu, x + h, 0, 0) - pseudoPotential(mu, x - h, 0, 0)) / (2 * h);
    const d2 = (pseudoPotential(mu, x + h, 0, 0) - 2 * pseudoPotential(mu, x, 0, 0)
      + pseudoPotential(mu, x - h, 0, 0)) / (h * h);
    x -= d1 / d2;
  }
  return [x, 0, 0];
}

// pseudoPotential の勾配を中心差分で近似する。
function numericalGradient(mu: number, x: number, y: number, z: number, h: number): [number, number, number] {
  const dx = (pseudoPotential(mu, x + h, y, z) - pseudoPotential(mu, x - h, y, z)) / (2 * h);
  const dy = (pseudoPotential(mu, x, y + h, z) - pseudoPotential(mu, x, y - h, z)) / (2 * h);
  const dz = (pseudoPotential(mu, x, y, z + h) - pseudoPotential(mu, x, y, z - h)) / (2 * h);
  return [dx, dy, dz];
}

// 点が閉じた折れ線の内側にあるかどうか(偶奇規則によるレイキャスト判定)。
function pointInPolygon(point: readonly [number, number], polygon: readonly (readonly [number, number])[]): boolean {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i] as [number, number];
    const [xj, yj] = polygon[j] as [number, number];
    const crosses = (yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

// 折れ線が囲む面積(シューレースの公式)。
function polygonArea(polygon: readonly (readonly [number, number])[]): number {
  let sum = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i] as [number, number];
    const [xj, yj] = polygon[j] as [number, number];
    sum += xj * yi - xi * yj;
  }
  return Math.abs(sum / 2);
}

// 点を囲む成分のうち面積最小のものを、その点が属する「島」の代表として返す(入れ子になった
// 複数の閉曲線があるとき、直接その点を取り囲む境界だけを拾うため)。囲む成分が無ければ null
// (孤立した点ではなく、外側の非有界な到達可能領域に属することを表す)。
function minimalEnclosingLoop(
  curves: readonly (readonly (readonly [number, number])[])[], point: readonly [number, number],
): readonly (readonly [number, number])[] | null {
  let best: readonly (readonly [number, number])[] | null = null;
  let bestArea = Infinity;
  // 点を含む成分の中で最小面積のものを残す。
  for (const curve of curves) {
    if (!pointInPolygon(point, curve)) continue;
    const area = polygonArea(curve);
    if (area < bestArea) {
      bestArea = area;
      best = curve;
    }
  }
  return best;
}
