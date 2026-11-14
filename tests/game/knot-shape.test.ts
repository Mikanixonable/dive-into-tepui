import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  KNOT_MAIN_RADIUS_MAX, KNOT_MAIN_RADIUS_MIN, KNOT_SEGMENT_SPHERES,
  KNOT_TUBE_RATIO_MAX, KNOT_TUBE_RATIO_MIN,
  generateKnotShape, knotParamsFromSeed, normalizeKnotParams, type KnotParams,
} from '../../src/game/knot/knot-shape';

// 生成器が満たすべき不変条件(SPEC/KNOT.md)。形状の見た目ではなく契約を固定する。

function baseParams(overrides: Partial<KnotParams>): KnotParams {
  return {
    family: 'torus', torusP: 2, torusQ: 3,
    freqX: 3, freqY: 4, freqZ: 7, phaseY: 0.9, phaseZ: 2.1,
    mainRadius: 150, tubeRatio: 0.13, strands: 1, weaveTurns: 18,
    bulgeAmp: 0.22, bulgeFreq: 6, bulgePhase: 0.4, fray: 0, seed: 11, nodeCount: 6,
    ...overrides,
  };
}

function gcd(a: number, b: number): number { return b === 0 ? a : gcd(b, a % b); }

// 隣り合う断面法線のなす角の最大 [deg]。管の折れはこの角の急反転として現れる。
function maxNormalStepDeg(params: KnotParams): number {
  const shape = generateKnotShape(params);
  let maxDeg = 0;
  for (const strand of shape.strands) {
    const normals = strand.normals;
    const count = normals.length;
    const steps = strand.closed ? count : count - 1;
    for (let i = 0; i < steps; i += 1) {
      const a = normals[i]!;
      const b = normals[(i + 1) % count]!;
      const d = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
      maxDeg = Math.max(maxDeg, (Math.acos(d) * 180) / Math.PI);
    }
  }
  return maxDeg;
}

export function register(): void {
  test('knot shape: 同じ seed から同じ形が再現される', () => {
    const a = generateKnotShape(knotParamsFromSeed(42));
    const b = generateKnotShape(knotParamsFromSeed(42));
    assert.deepEqual(a, b);
    const c = generateKnotShape(knotParamsFromSeed(43));
    assert.notDeepEqual(a.params, c.params);
  });

  test('knot shape: seed から引くパラメーターは実用域に収まる', () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const params = knotParamsFromSeed(seed);
      assert.ok(params.mainRadius >= KNOT_MAIN_RADIUS_MIN && params.mainRadius <= KNOT_MAIN_RADIUS_MAX, `seed ${seed}: mainRadius ${params.mainRadius}`);
      assert.ok(params.tubeRatio >= KNOT_TUBE_RATIO_MIN && params.tubeRatio <= KNOT_TUBE_RATIO_MAX, `seed ${seed}: tubeRatio ${params.tubeRatio}`);
      assert.ok(params.strands >= 1 && params.strands <= 3, `seed ${seed}: strands`);
      assert.ok(params.nodeCount >= 3 && params.nodeCount <= 9, `seed ${seed}: nodeCount`);
      assert.equal(gcd(params.torusP, params.torusQ), 1, `seed ${seed}: torus が互いに素でない`);
      assert.equal(gcd(gcd(params.freqX, params.freqY), params.freqZ), 1, `seed ${seed}: lissajous に公約数`);
      // 巻数の大きな形には編みとほつれを重ねない(KNOT.md)。
      const high = params.family === 'torus'
        ? Math.max(params.torusP, params.torusQ) >= 5
        : params.freqX + params.freqY + params.freqZ >= 15;
      if (high) {
        assert.equal(params.strands, 1, `seed ${seed}: 高巻数に編みが重なっている`);
        assert.equal(params.fray, 0, `seed ${seed}: 高巻数にほつれが重なっている`);
      }
    }
  });

  test('knot shape: 域外のパラメーターは実用域へ収めてから生成する', () => {
    const normalized = normalizeKnotParams(baseParams({
      mainRadius: 500, tubeRatio: 0.3, strands: 7, fray: 2, nodeCount: 20,
    }));
    assert.equal(normalized.mainRadius, KNOT_MAIN_RADIUS_MAX);
    assert.equal(normalized.tubeRatio, KNOT_TUBE_RATIO_MAX);
    assert.equal(normalized.strands, 3);
    assert.equal(normalized.fray, 0.7);
    assert.equal(normalized.nodeCount, 9);
    const coprime = normalizeKnotParams(baseParams({ torusP: 2, torusQ: 4 }));
    assert.equal(gcd(coprime.torusP, coprime.torusQ), 1);
    const lissajous = normalizeKnotParams(baseParams({ family: 'lissajous', freqX: 3, freqY: 6, freqZ: 9 }));
    assert.deepEqual([lissajous.freqX, lissajous.freqY, lissajous.freqZ], [1, 2, 3]);
    // 巻数の大きな形からは、明示指定でも編みとほつれを外す。
    const high = normalizeKnotParams(baseParams({ torusP: 2, torusQ: 7, strands: 3, fray: 0.5 }));
    assert.equal(high.strands, 1);
    assert.equal(high.fray, 0);
  });

  test('knot shape: 高曲率でも断面フレームは折れない', () => {
    // 設計上の保証は、1区間の接線の回転を抑えたうえでの 25° 以下。90° を超えると
    // 断面が反転して管が折れて見える(KNOT.md の品質要件)。
    const hardCases: [string, KnotParams][] = [
      ['torus (2,7)', baseParams({ torusP: 2, torusQ: 7, tubeRatio: 0.16 })],
      ['torus (3,5)', baseParams({ torusP: 3, torusQ: 5 })],
      ['torus braid3 fray', baseParams({ strands: 3, fray: 0.55, tubeRatio: 0.11 })],
      ['lissajous (5,6,11)', baseParams({ family: 'lissajous', freqX: 5, freqY: 6, freqZ: 11 })],
      ['lissajous (3,5,8) braid2 fray', baseParams({ family: 'lissajous', freqX: 3, freqY: 5, freqZ: 8, strands: 2, fray: 0.35 })],
      ['lissajous (3,4,7) braid2', baseParams({ family: 'lissajous', strands: 2, weaveTurns: 14, seed: 57 })],
    ];
    for (const [name, params] of hardCases) {
      const deg = maxNormalStepDeg(params);
      assert.ok(deg <= 25, `${name}: 法線の段差 ${deg.toFixed(1)}deg`);
    }
    for (let seed = 0; seed < 100; seed += 1) {
      const deg = maxNormalStepDeg(knotParamsFromSeed(seed));
      assert.ok(deg <= 25, `seed ${seed}: 法線の段差 ${deg.toFixed(1)}deg`);
    }
  });

  test('knot shape: 法線は単位長で、頂点は有限な範囲に収まる', () => {
    for (let seed = 0; seed < 30; seed += 1) {
      const shape = generateKnotShape(knotParamsFromSeed(seed));
      for (const strand of shape.strands) {
        for (const normal of strand.normals) {
          const len = Math.hypot(normal[0], normal[1], normal[2]);
          assert.ok(Math.abs(len - 1) < 1e-3, `seed ${seed}: 法線の長さ ${len}`);
        }
        for (const point of strand.centerline) {
          assert.ok(point.every(Number.isFinite), `seed ${seed}: 非有限な中心線の点`);
          const reach = Math.hypot(point[0], point[1], point[2]) + strand.tubeRadius;
          assert.ok(reach <= shape.outerRadius + 1e-6, `seed ${seed}: 外接半径を超える点`);
        }
      }
      for (const array of [shape.sheath.positions, shape.bare.positions]) {
        for (const value of array) assert.ok(Number.isFinite(value), `seed ${seed}: 非有限な頂点`);
      }
      assert.equal(shape.sheath.vertexCount + shape.bare.vertexCount, shape.vertexCount);
      assert.ok(shape.vertexCount > 0 && shape.triangleCount > 0);
    }
  });

  test('knot shape: ほつれ 0 で閉じ、ほつれがあれば開く', () => {
    const closed = generateKnotShape(baseParams({ fray: 0 }));
    assert.ok(closed.strands.every((strand) => strand.closed));
    const open = generateKnotShape(baseParams({ fray: 0.5 }));
    assert.ok(open.strands.every((strand) => !strand.closed));
  });

  test('knot shape: 判定球は中心線を覆い、セグメントは球列を区切る', () => {
    for (let seed = 0; seed < 30; seed += 1) {
      const shape = generateKnotShape(knotParamsFromSeed(seed));
      const sphereRadius = shape.spheres[0]!.radius;
      // セグメントの区間は球列全体を、重なりなく連続して覆う。
      let cursor = 0;
      for (const segment of shape.segments) {
        assert.equal(segment.sphereStart, cursor, `seed ${seed}: セグメントの開始位置`);
        assert.ok(segment.sphereCount >= 1 && segment.sphereCount <= KNOT_SEGMENT_SPHERES);
        for (let i = 0; i < segment.sphereCount; i += 1) {
          assert.equal(shape.spheres[segment.sphereStart + i]!.segment, segment.index);
        }
        cursor += segment.sphereCount;
      }
      assert.equal(cursor, shape.spheres.length);
      // どの索の中心線の点も、いずれかの球の内側にある。
      for (const strand of shape.strands) {
        for (let i = 0; i < strand.centerline.length; i += 7) {
          const point = strand.centerline[i]!;
          let nearest = Infinity;
          for (const sphere of shape.spheres) {
            const d = Math.hypot(
              point[0] - sphere.center[0], point[1] - sphere.center[1], point[2] - sphere.center[2],
            );
            nearest = Math.min(nearest, d);
          }
          assert.ok(nearest <= sphereRadius * 1.05, `seed ${seed}: 球に覆われない中心線の点 (${nearest.toFixed(1)} > ${sphereRadius.toFixed(1)})`);
        }
      }
    }
  });

  test('knot shape: ノードは役割を持って索の上に付き、中核は1つある', () => {
    for (let seed = 0; seed < 30; seed += 1) {
      const shape = generateKnotShape(knotParamsFromSeed(seed));
      assert.equal(shape.nodes.length, shape.params.nodeCount, `seed ${seed}: ノード数`);
      const roles = new Set(shape.nodes.map((node) => node.role));
      assert.deepEqual([...roles].sort(), ['drive', 'sensor', 'shooter'], `seed ${seed}: 役割の欠け`);
      for (const node of shape.nodes) {
        const line = shape.strands[node.strand]!.centerline;
        const onLine = line.some((point) => (
          point[0] === node.position[0] && point[1] === node.position[1] && point[2] === node.position[2]
        ));
        assert.ok(onLine, `seed ${seed}: ノードが索の中心線の上に無い`);
        assert.ok(node.radius > shape.strands[node.strand]!.tubeRadius, `seed ${seed}: ノードが管より小さい`);
      }
      assert.ok(shape.core.radius > 0, `seed ${seed}: 中核の半径`);
      const coreReach = Math.hypot(...shape.core.position) + shape.core.radius;
      assert.ok(coreReach <= shape.outerRadius + 1e-6, `seed ${seed}: 中核が外接半径の外`);
    }
  });

  test('knot shape: 生成コストは出現時1回として収まる', () => {
    // 実用域で最も重い部類(3本編み・ほつれ・最大級)を繰り返し測り、1回が
    // 1 秒を大きく下回ることを見る。出現を待たせる仕掛けが要らない水準。
    const heavy = baseParams({
      family: 'lissajous', freqX: 3, freqY: 5, freqZ: 8,
      mainRadius: 300, tubeRatio: 0.18, strands: 3, fray: 0.6, nodeCount: 9,
    });
    for (let i = 0; i < 3; i += 1) {
      const start = performance.now();
      generateKnotShape(heavy);
      const ms = performance.now() - start;
      assert.ok(ms < 1000, `生成に ${ms.toFixed(0)}ms かかった`);
    }
  });
}
