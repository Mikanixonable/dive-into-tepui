// 点群生成が決定論的であること、カークウッドの空隙が抜けていること、トロヤ群が L4/L5 近傍に
// 集まっていること、カイパーベルト cold/hot の傾斜角分布が分離していること、散乱円盤の近日点が
// 想定域に収まっていること、ヒルダ群が木星に対して三角形状に分布することの回帰テスト。
import assert from 'node:assert/strict';
import { test } from '../harness';
import {
  PointElements, PointField, generatePointField, jupiterMeanLongitude, pointPositionAt,
} from '../../src/game/celestial/point-field';
import { AU } from '../../src/physics/planet-orbit';

const DEG = Math.PI / 180;

// 群の区別を捨てて全点を1列に並べる。同じ種から同じ点群が出ることを見るための形。
function allPoints(field: PointField): readonly PointElements[] {
  return field.flatMap((group) => group.points);
}

// 角を [-π, π] へ畳む。
function wrapPi(x: number): number {
  return Math.atan2(Math.sin(x), Math.cos(x));
}

function groupOf(field: PointField, id: string) {
  const group = field.find((g) => g.id === id);
  assert.ok(group, `missing group ${id}`);
  return group!;
}

export function register(): void {
  test('point-field: the same seed produces the same field', () => {
    const a = allPoints(generatePointField(12345));
    const b = allPoints(generatePointField(12345));
    assert.deepEqual(a, b);
    const c = allPoints(generatePointField(12346));
    assert.notDeepEqual(a, c);
  });

  test('point-field: Kirkwood gaps are depleted relative to their surroundings', () => {
    const field = generatePointField();
    const au = groupOf(field, 'main-belt').points.map((el) => el.a / AU);
    for (const gap of [2.06, 2.5, 2.82, 2.958, 3.28]) {
      const inGap = au.filter((x) => Math.abs(x - gap) < 0.02).length;
      const nearby = au.filter((x) => {
        const d = Math.abs(x - gap);
        return d >= 0.06 && d < 0.1;
      }).length;
      // 幅の等しい帯どうしの比較なので、点数をそのまま比べられる。
      assert.ok(inGap < nearby / 3, `gap ${gap}: ${inGap} in gap vs ${nearby} nearby`);
    }
  });

  test('point-field: trojans stay within 35 degrees of L4/L5', () => {
    const field = generatePointField();
    const lj = jupiterMeanLongitude(0);
    for (const [id, lead] of [['trojan-l4', 60], ['trojan-l5', -60]] as const) {
      const points = groupOf(field, id).points;
      assert.ok(points.length > 0);
      for (const el of points) {
        const off = wrapPi(el.l0 - lj - lead * DEG) / DEG;
        assert.ok(Math.abs(off) <= 35, `trojan offset ${off} deg from L${lead > 0 ? 4 : 5}`);
      }
    }
  });

  test('point-field: Kuiper cold/hot inclination distributions are separated', () => {
    const field = generatePointField();
    const cold = groupOf(field, 'kuiper-cold').points.map((el) => el.inc);
    const hot = groupOf(field, 'kuiper-hot').points.map((el) => el.inc);
    const coldMax = Math.max(...cold);
    const hotMean = hot.reduce((s, x) => s + x, 0) / hot.length;
    assert.ok(coldMax < hotMean, `cold max ${coldMax / DEG} deg should be below hot mean ${hotMean / DEG} deg`);
  });

  test('point-field: scattered disk perihelion stays within 30-40 AU', () => {
    const field = generatePointField();
    for (const el of groupOf(field, 'scattered-disk').points) {
      const qAu = (el.a * (1 - el.e)) / AU;
      assert.ok(qAu >= 30 - 1e-6 && qAu <= 40 + 1e-6, `perihelion ${qAu} AU out of range`);
    }
  });

  // ヒルダ群が三角形に見えるかは、共鳴角そのものではなく**実際の日心黄経の分布**で見る —
  // σ の集まり方を検査すると生成式をそのまま読み返すだけの循環したテストになる。
  // 3:2 共鳴では M = 3(λ_H − λ_J) + σ となるため遠日点が木星に対して 120° おきの3方向で
  // 繰り返し、遠日点付近に長く留まる効果で3箇所に濃淡が出る(頂点は木星の L4/L3/L5)。
  test('point-field: hildas form a triangle in longitude relative to Jupiter', () => {
    const points = groupOf(generatePointField(), 'hilda').points;
    // dσ/dt = 0 になるよう a を選んであるはずなので、t=0 以外でも同じ三角形が保たれる。
    const t = 1e8;
    const lj = jupiterMeanLongitude(t);
    const sunward = pointPositionAt(points[0]!, t);
    assert.ok(Number.isFinite(sunward.x), '位置評価が有限であること');

    // 木星に対する相対黄経の 30° 刻みヒストグラム。
    const bins = new Array(12).fill(0);
    for (const el of points) {
      const p = pointPositionAt(el, t);
      // 黄道面上の方位角。ECI(Y=北極)なので黄経方向は x-z 面で測る。
      const rel = wrapPi(Math.atan2(-p.z, p.x) - lj);
      bins[Math.min(11, Math.floor(((rel / DEG + 180) % 360) / 30))]! += 1;
    }
    const peak = Math.max(...bins);
    const valley = Math.min(...bins);
    // 一様分布ならピークと谷はほぼ等しい。三角形なら明確な濃淡が出る。
    assert.ok(peak / valley > 2, `三角形の濃淡が出ていない: peak=${peak} valley=${valley}`);
    // 濃い側が3箇所に分かれていること(頂点が3つ)。
    const threshold = (peak + valley) / 2;
    let runs = 0;
    for (let i = 0; i < 12; i++) {
      if (bins[i]! >= threshold && bins[(i + 11) % 12]! < threshold) runs++;
    }
    assert.equal(runs, 3, `濃い領域が3箇所でない: ${runs} (bins=${bins.join(',')})`);
  });
}
