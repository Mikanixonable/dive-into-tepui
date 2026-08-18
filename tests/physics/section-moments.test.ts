// section-moments.ts の回帰テスト。断面の幾何量はすべて閉形式で求まるはずなので、正多角形・円・
// 楕円の既知の解析解、平行軸の定理、対称性から決まる Ixy = 0 を、いずれも厳しい許容差で固定する。
import * as assert from 'node:assert/strict';
import { test } from './harness';
import {
  CrossSection,
  PORT_WIDTH_RATIO,
  SectionPrimitive,
  Vec2,
  circleSegmentMoments,
  notchedPolygonVertices,
  polygonArea,
  polygonCentroid,
  polygonSecondMoments,
  polygonSecondMomentsAboutOrigin,
  regularPolygonVertices,
  sectionMoments,
} from '../../src/physics/section-moments';

function close(actual: number, expected: number, tolerance: number, label: string): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} vs ${expected} (差 ${Math.abs(actual - expected)}, 許容 ${tolerance})`,
  );
}

// 外接円半径 radius の正 sides 角形の面積 [m²]。
function regularArea(sides: number, radius: number): number {
  return (sides / 2) * radius * radius * Math.sin((2 * Math.PI) / sides);
}

// 外接円半径 radius の正 sides 角形の、重心を通る任意の軸まわりの断面二次モーメント [m⁴]。
function regularSecondMoment(sides: number, radius: number): number {
  const side = 2 * radius * Math.sin(Math.PI / sides);
  return (regularArea(sides, radius) / 24) * (6 * radius * radius - side * side);
}

function translated(vertices: readonly Vec2[], dx: number, dy: number): readonly Vec2[] {
  return vertices.map((v) => ({ x: v.x + dx, y: v.y + dy }));
}

function edgeLengths(vertices: readonly Vec2[]): number[] {
  return vertices.map((v, i) => {
    const next = vertices[(i + 1) % vertices.length]!;
    return Math.hypot(next.x - v.x, next.y - v.y);
  });
}

function primitive(over: Partial<SectionPrimitive> & Pick<SectionPrimitive, 'id' | 'shape'>): SectionPrimitive {
  return { phaseAngle: 0, attachment: null, ...over };
}

// 正方形の外接円半径 squareRadius に、辺の長さの等しい正三角形を1つ貼り付けた複合断面。
function squareWithTriangle(squareRadius: number, squarePhase: number): CrossSection {
  const squareSide = squareRadius * Math.SQRT2;
  return {
    primitives: [
      primitive({ id: 'square', shape: { kind: 'polygon', sides: 4, radius: squareRadius }, phaseAngle: squarePhase }),
      primitive({
        id: 'triangle',
        shape: { kind: 'polygon', sides: 3, radius: squareSide / Math.sqrt(3) },
        attachment: { parentId: 'square', parentFaceIndex: 0, childFaceIndex: 0 },
      }),
    ],
  };
}

export function register(): void {
  test('section-moments: 単位正方形の面積・重心・断面二次モーメントが解析解と一致する', () => {
    const square: readonly Vec2[] = [
      { x: -0.5, y: -0.5 },
      { x: 0.5, y: -0.5 },
      { x: 0.5, y: 0.5 },
      { x: -0.5, y: 0.5 },
    ];
    close(polygonArea(square), 1, 1e-15, '単位正方形の面積');
    const moments = polygonSecondMoments(square);
    close(moments.ix, 1 / 12, 1e-15, '単位正方形の Ix');
    close(moments.iy, 1 / 12, 1e-15, '単位正方形の Iy');
    close(moments.ixy, 0, 1e-15, '単位正方形の Ixy');
  });

  test('section-moments: 正多角形の面積と断面二次モーメントが閉形式と一致し、Ix == Iy かつ Ixy == 0', () => {
    const radius = 1.25;
    for (const sides of [3, 4, 5, 6, 8]) {
      const vertices = regularPolygonVertices(sides, radius, 0.37);
      const area = polygonArea(vertices);
      close(area, regularArea(sides, radius), 1e-12, `正${sides}角形の面積`);
      const moments = polygonSecondMoments(vertices);
      close(moments.ix, regularSecondMoment(sides, radius), 1e-12, `正${sides}角形の Ix`);
      close(moments.iy, regularSecondMoment(sides, radius), 1e-12, `正${sides}角形の Iy`);
      // 正多角形は3回以上の回転対称を持つため、断面二次モーメントの主軸が定まらない(等方)。
      close(moments.ix - moments.iy, 0, 1e-12, `正${sides}角形の Ix と Iy の差`);
      close(moments.ixy, 0, 1e-12, `正${sides}角形の Ixy`);
    }
  });

  test('section-moments: 辺数を増やした正多角形が円の値へ収束する', () => {
    const radius = 1;
    const vertices = regularPolygonVertices(2048, radius, 0);
    close(polygonArea(vertices), Math.PI * radius * radius, 1e-5, '正2048角形の面積');
    const moments = polygonSecondMoments(vertices);
    close(moments.ix, (Math.PI * radius ** 4) / 4, 1e-5, '正2048角形の Ix');
    close(moments.iy, (Math.PI * radius ** 4) / 4, 1e-5, '正2048角形の Iy');

    const coarse = polygonArea(regularPolygonVertices(64, radius, 0));
    const fine = polygonArea(regularPolygonVertices(256, radius, 0));
    assert.ok(
      Math.abs(fine - Math.PI) < Math.abs(coarse - Math.PI),
      `辺数を増やすと円の面積へ近づくべき: 64辺 ${coarse}, 256辺 ${fine}`,
    );
  });

  test('section-moments: 重心を原点へ移した断面の1次モーメントが消える', () => {
    const vertices = regularPolygonVertices(5, 0.75, 0.2);
    const moved = translated(vertices, 3.5, -2.25);
    const centroid = polygonCentroid(moved);
    close(centroid.x, 3.5, 1e-12, '平行移動した正五角形の重心 x');
    close(centroid.y, -2.25, 1e-12, '平行移動した正五角形の重心 y');

    const centered = translated(moved, -centroid.x, -centroid.y);
    const recentered = polygonCentroid(centered);
    const area = polygonArea(centered);
    close(area * recentered.x, 0, 1e-12, '重心まわりの1次モーメント x');
    close(area * recentered.y, 0, 1e-12, '重心まわりの1次モーメント y');
  });

  test('section-moments: 原点まわりの断面二次モーメントが平行軸の定理と一致する', () => {
    const vertices = translated(regularPolygonVertices(5, 0.75, 0.2), 2, 3);
    const area = polygonArea(vertices);
    const centroid = polygonCentroid(vertices);
    const centroidal = polygonSecondMoments(vertices);
    const origin = polygonSecondMomentsAboutOrigin(vertices);
    close(origin.ix, centroidal.ix + area * centroid.y * centroid.y, 1e-12, '平行軸の定理 (Ix)');
    close(origin.iy, centroidal.iy + area * centroid.x * centroid.x, 1e-12, '平行軸の定理 (Iy)');
    close(origin.ixy, centroidal.ixy + area * centroid.x * centroid.y, 1e-12, '平行軸の定理 (Ixy)');
  });

  test('section-moments: 半円2つの弓形が円の解析値になる', () => {
    const radius = 1.3;
    const half = circleSegmentMoments(radius, Math.PI / 2);
    close(half.area, (Math.PI * radius * radius) / 2, 1e-12, '半円の面積');
    close(half.centroidDist, (4 * radius) / (3 * Math.PI), 1e-12, '半円の重心距離');
    close(2 * half.ix, (Math.PI * radius ** 4) / 4, 1e-12, '半円2つの Ix');
    close(2 * half.iy, (Math.PI * radius ** 4) / 4, 1e-12, '半円2つの Iy');
  });

  test('section-moments: 円断面の面積が分岐数ぶんの弓形を引いた解析値と一致する', () => {
    const radius = 1.5;
    const halfAngle = Math.asin(PORT_WIDTH_RATIO / 2);
    const segment = circleSegmentMoments(radius, halfAngle);
    for (const branchCount of [2, 3, 4, 5, 6] as const) {
      const section: CrossSection = {
        primitives: [primitive({ id: 'c', shape: { kind: 'circle', radius, branchCount }, phaseAngle: 0.11 })],
      };
      const moments = sectionMoments(section);
      const expected = Math.PI * radius * radius - branchCount * segment.area;
      close(moments.area, expected, 1e-12, `分岐数${branchCount}の円断面の面積`);
      // 等分した方向へ同じ弓形を引くので、重心は円の中心に留まる。
      close(moments.centroid.x, 0, 1e-12, `分岐数${branchCount}の円断面の重心 x`);
      close(moments.centroid.y, 0, 1e-12, `分岐数${branchCount}の円断面の重心 y`);
    }
  });

  test('section-moments: 分岐数が3以上の円断面は等方、分岐数2は主軸を持つ', () => {
    const radius = 1.5;
    for (const branchCount of [3, 4, 5, 6] as const) {
      const moments = sectionMoments({
        primitives: [primitive({ id: 'c', shape: { kind: 'circle', radius, branchCount }, phaseAngle: 0.4 })],
      });
      close(moments.ix - moments.iy, 0, 1e-12, `分岐数${branchCount}の円断面の Ix と Iy の差`);
      close(moments.ixy, 0, 1e-12, `分岐数${branchCount}の円断面の Ixy`);
    }
    const twoPorts = sectionMoments({
      primitives: [primitive({ id: 'c', shape: { kind: 'circle', radius, branchCount: 2 } })],
    });
    // 口が ±x にあるぶん ∫x²dA だけが大きく減るため、Iy が Ix より小さくなる。
    assert.ok(twoPorts.iy < twoPorts.ix, `分岐数2の円断面は Iy < Ix であるべき: ${twoPorts.iy} vs ${twoPorts.ix}`);
    close(twoPorts.ixy, 0, 1e-12, '分岐数2の円断面の Ixy');
  });

  test('section-moments: 分岐数6の円断面が正六角形と一致する', () => {
    // 口の弦が半径と等しいとき、6つの弓形はちょうど円を覆い尽くし、残りは正六角形そのものになる。
    assert.equal(PORT_WIDTH_RATIO, 1, 'この一致は口の幅の比が 1 であることに依る');
    const radius = 1.25;
    const circle = sectionMoments({
      primitives: [primitive({ id: 'c', shape: { kind: 'circle', radius, branchCount: 6 } })],
    });
    const hexagon = regularPolygonVertices(6, radius, Math.PI / 6);
    close(circle.area, polygonArea(hexagon), 1e-12, '分岐数6の円断面の面積');
    const expected = polygonSecondMoments(hexagon);
    close(circle.ix, expected.ix, 1e-12, '分岐数6の円断面の Ix');
    close(circle.iy, expected.iy, 1e-12, '分岐数6の円断面の Iy');
  });

  test('section-moments: 楕円断面が解析解と一致し、位相で主軸が回る', () => {
    const a = 1.5;
    const b = 0.75;
    const upright = sectionMoments({
      primitives: [primitive({ id: 'e', shape: { kind: 'ellipse', majorRadius: a, minorRadius: b } })],
    });
    close(upright.area, Math.PI * a * b, 1e-12, '楕円の面積');
    close(upright.ix, (Math.PI * a * b * b * b) / 4, 1e-12, '楕円の Ix');
    close(upright.iy, (Math.PI * a * a * a * b) / 4, 1e-12, '楕円の Iy');
    close(upright.ixy, 0, 1e-12, '楕円の Ixy');

    const turned = sectionMoments({
      primitives: [
        primitive({ id: 'e', shape: { kind: 'ellipse', majorRadius: a, minorRadius: b }, phaseAngle: Math.PI / 2 }),
      ],
    });
    close(turned.ix, upright.iy, 1e-12, '90度回した楕円の Ix');
    close(turned.iy, upright.ix, 1e-12, '90度回した楕円の Iy');
    close(turned.ixy, 0, 1e-12, '90度回した楕円の Ixy');
  });

  test('section-moments: 切り欠き型多角形の辺長が 1:2 で交互し、頂点が外接円上に乗る', () => {
    const radius = 1.75;
    for (const sides of [6, 8] as const) {
      const vertices = notchedPolygonVertices(sides, radius, 0.29);
      assert.equal(vertices.length, sides, `切り欠き${sides}角形の頂点数`);
      for (const v of vertices) {
        close(Math.hypot(v.x, v.y), radius, 1e-12, `切り欠き${sides}角形の外接円半径`);
      }
      const lengths = edgeLengths(vertices);
      const short = lengths[0]!;
      const long = lengths[1]!;
      for (let i = 0; i < lengths.length; i++) {
        close(lengths[i]!, i % 2 === 0 ? short : long, 1e-12, `切り欠き${sides}角形の辺長の交互性`);
      }
      close(long / short, 2, 1e-12, `切り欠き${sides}角形の長辺と短辺の比`);
      assert.ok(
        polygonArea(vertices) < regularArea(sides, radius),
        `切り欠き${sides}角形は同じ外接円の正${sides}角形より小さいべき`,
      );
    }
  });

  test('section-moments: 切り欠き型多角形の面積が元の多角形から角を落とした値と一致する', () => {
    const radius = 1.75;
    // 切り欠き八角形は、一辺 squareSide の正方形の四隅から直角二等辺三角形を落とした形。
    const octagonCut = radius / Math.sqrt(5 + 2 * Math.SQRT2);
    const squareSide = 2 * octagonCut * (1 + Math.SQRT2);
    const octagon = notchedPolygonVertices(8, radius, 0.13);
    close(
      polygonArea(octagon),
      squareSide * squareSide - 2 * octagonCut * octagonCut,
      1e-12,
      '切り欠き八角形の面積',
    );

    // 切り欠き六角形は、一辺 triangleSide の正三角形の三隅から正三角形を落とした形。
    const hexagonCut = radius * Math.sqrt(3 / 7);
    const triangleSide = 4 * hexagonCut;
    const hexagon = notchedPolygonVertices(6, radius, -0.4);
    close(
      polygonArea(hexagon),
      (Math.sqrt(3) / 4) * (triangleSide * triangleSide - 3 * hexagonCut * hexagonCut),
      1e-12,
      '切り欠き六角形の面積',
    );
  });

  test('section-moments: 切り欠き型多角形は等方で Ixy が 0 になる', () => {
    for (const sides of [6, 8] as const) {
      const moments = polygonSecondMoments(notchedPolygonVertices(sides, 1.75, 0.29));
      close(moments.ix - moments.iy, 0, 1e-12, `切り欠き${sides}角形の Ix と Iy の差`);
      close(moments.ixy, 0, 1e-12, `切り欠き${sides}角形の Ixy`);
    }
  });

  test('section-moments: 複合断面の面積が構成要素の和と一致し、重心が貼り付けた側へ寄る', () => {
    const radius = 1;
    const section = squareWithTriangle(radius, 0);
    const moments = sectionMoments(section);
    const squareArea = regularArea(4, radius);
    const triangleArea = regularArea(3, (radius * Math.SQRT2) / Math.sqrt(3));
    close(moments.area, squareArea + triangleArea, 1e-12, '複合断面の面積');
    // 正方形の位相0では辺0の外向き法線が45度を向くので、重心もその向きへ寄る。
    assert.ok(moments.centroid.x > 0 && moments.centroid.y > 0, `重心が貼り付けた側へ寄るべき: ${JSON.stringify(moments.centroid)}`);
    close(moments.centroid.x - moments.centroid.y, 0, 1e-12, '45度方向へ寄った重心の対称性');
  });

  test('section-moments: 非対称な複合断面の Ixy は 0 でなく、対称に置き直すと 0 になる', () => {
    const radius = 1;
    const tilted = sectionMoments(squareWithTriangle(radius, 0));
    assert.ok(Math.abs(tilted.ixy) > 1e-3, `非対称な複合断面の Ixy は 0 でないべき: ${tilted.ixy}`);

    // 同じ形を -45 度回すと対称軸が x 軸に乗るため、主軸が座標軸と揃って Ixy が消える。
    const aligned = sectionMoments(squareWithTriangle(radius, -Math.PI / 4));
    close(aligned.area, tilted.area, 1e-12, '回しても面積は変わらない');
    close(aligned.ixy, 0, 1e-12, '対称軸を x 軸に乗せた複合断面の Ixy');
    close(aligned.centroid.y, 0, 1e-12, '対称軸を x 軸に乗せた複合断面の重心 y');
    assert.ok(
      Math.abs(aligned.ix - aligned.iy) > 1e-3,
      `主軸が座標軸に乗った断面の Ix と Iy は異なるべき: ${aligned.ix} vs ${aligned.iy}`,
    );
  });

  test('section-moments: 複合断面が、貼り合わせた形をそのまま書いた多角形と一致する', () => {
    const radius = 1;
    // 位相0の正方形の辺0(頂点 (1,0) と (0,1) の間)へ正三角形を貼ると、外周は五角形になる。
    const apexDistance = Math.SQRT1_2 + (radius * Math.SQRT2 * Math.sqrt(3)) / 2;
    const pentagon: readonly Vec2[] = [
      { x: radius, y: 0 },
      { x: apexDistance * Math.SQRT1_2, y: apexDistance * Math.SQRT1_2 },
      { x: 0, y: radius },
      { x: -radius, y: 0 },
      { x: 0, y: -radius },
    ];
    const composite = sectionMoments(squareWithTriangle(radius, 0));
    const expected = polygonSecondMoments(pentagon);
    close(composite.area, polygonArea(pentagon), 1e-12, '五角形として書いた複合断面の面積');
    close(composite.centroid.x, polygonCentroid(pentagon).x, 1e-12, '五角形として書いた複合断面の重心 x');
    close(composite.centroid.y, polygonCentroid(pentagon).y, 1e-12, '五角形として書いた複合断面の重心 y');
    close(composite.ix, expected.ix, 1e-12, '五角形として書いた複合断面の Ix');
    close(composite.iy, expected.iy, 1e-12, '五角形として書いた複合断面の Iy');
    close(composite.ixy, expected.ixy, 1e-12, '五角形として書いた複合断面の Ixy');
  });

  test('section-moments: 木構造として不正な断面は例外になる', () => {
    const square = primitive({ id: 'square', shape: { kind: 'polygon', sides: 4, radius: 1 } });
    const attachment = { parentId: 'square', parentFaceIndex: 0, childFaceIndex: 0 };

    assert.throws(
      () =>
        sectionMoments({
          primitives: [square, primitive({ id: 'bad', shape: { kind: 'polygon', sides: 3, radius: 1 }, attachment })],
        }),
      /face lengths differ/,
      '辺の長さが違う貼り付けは不正',
    );
    assert.throws(
      () =>
        sectionMoments({
          primitives: [
            square,
            primitive({ id: 'bad', shape: { kind: 'circle', radius: 1, branchCount: 4 }, attachment }),
          ],
        }),
      /can only be the root/,
      '円は子として貼り付けられない',
    );
    assert.throws(
      () => sectionMoments({ primitives: [square, primitive({ id: 'other', shape: square.shape })] }),
      /exactly one root/,
      '根は1つでなければならない',
    );
    assert.throws(
      () =>
        sectionMoments({
          primitives: [
            square,
            primitive({
              id: 'bad',
              shape: { kind: 'polygon', sides: 4, radius: 1 },
              attachment: { parentId: 'missing', parentFaceIndex: 0, childFaceIndex: 0 },
            }),
          ],
        }),
      /unknown parent/,
      '存在しない親への貼り付けは不正',
    );
  });
}
