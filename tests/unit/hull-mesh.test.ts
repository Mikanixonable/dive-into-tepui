// 形状ツリーから生成した外皮メッシュ(§F12)の回帰テスト。三角形の面積が解析値と一致することと、
// 露出した端面だけが塞がれることを固定する。
import * as assert from 'node:assert/strict';
import * as C from '../../src/game/const';
import { buildHullTriangles, trianglesArea } from '../../src/render/hull/hull-triangles';
import type { HullShape } from '../../src/render/hull/hull-triangles';
import { HULL_LOD_SAMPLES, hullShapeOf } from '../../src/game/vessel/hull-shape';
import { loftLateralArea, sectionOutline } from '../../src/physics/hull-loft';
import { polygonArea } from '../../src/physics/section-moments';
import {
  crewedAssembly, hostileAssembly, orbitalBaseAssembly,
} from '../../src/game/vessel/vessel-assemblies';
import { nodeById } from '../../src/game/vessel/tree';
import { v3 } from '../../src/physics/vec3';
import { test } from '../physics/harness';

// 帯の側面だけを取り出した形。蓋と骨組みを外すと、面積は loftLateralArea と比較できる。
function bandsOnly(shape: HullShape): HullShape {
  return {
    bands: shape.bands.map((band) => ({ ...band, capA: false, capB: false })),
    beams: [],
  };
}

export function register(): void {
  test('ロフト帯の面積が loftLateralArea と一致する', () => {
    // 両端の基底を揃えた1本の帯を組み、解析値と突き合わせる。基底が揃っていれば頂点の対応は
    // 添字そのものになり、loftLateralArea が測る帯と同じものが出る。
    const tree = crewedAssembly(C.PLAYER_MAX_HP).tree;
    const outlineA = sectionOutline(nodeById(tree, 'nose').section, HULL_LOD_SAMPLES.near);
    const outlineB = sectionOutline(nodeById(tree, 'fore-node').section, HULL_LOD_SAMPLES.near);
    const length = 1.5;
    const frame = { x: v3(1, 0, 0), y: v3(0, 1, 0), z: v3(0, 0, 1) };
    const shape: HullShape = {
      bands: [{
        outlineA, outlineB,
        frameA: { origin: v3(0, 0, 0), ...frame },
        frameB: { origin: v3(0, 0, length), ...frame },
        capA: false, capB: false,
      }],
      beams: [],
    };
    const meshArea = trianglesArea(buildHullTriangles(shape));
    const analytic = loftLateralArea(outlineA, outlineB, length);
    assert.ok(analytic > 0);
    assert.ok(Math.abs(meshArea - analytic) / analytic < 1e-6, `${meshArea} vs ${analytic}`);
  });

  test('既定の有人艦の外皮が、各エッジの解析値どおりの側面積になる', () => {
    const tree = crewedAssembly(C.PLAYER_MAX_HP).tree;
    const meshArea = trianglesArea(buildHullTriangles(bandsOnly(hullShapeOf(tree, 'near'))));
    let analytic = 0;
    for (const edge of tree.edges) {
      if (edge.kind.kind !== 'hull') continue;
      analytic += loftLateralArea(
        sectionOutline(nodeById(tree, edge.a).section, HULL_LOD_SAMPLES.near),
        sectionOutline(nodeById(tree, edge.b).section, HULL_LOD_SAMPLES.near),
        edge.length,
      );
    }
    // 隣り合う断面の回転位相が違うぶん、共通面で取り直した対応は添字そのものとは一致しない。
    // ねじれていれば面積は目に見えて増えるので、その差が数%に収まることを固定する。
    assert.ok(Math.abs(meshArea - analytic) / analytic < 0.03, `${meshArea} vs ${analytic}`);
  });

  test('露出した端面だけが蓋を持つ', () => {
    const tree = crewedAssembly(C.PLAYER_MAX_HP).tree;
    const shape = hullShapeOf(tree, 'near');
    const caps = shape.bands.reduce((n, b) => n + (b.capA ? 1 : 0) + (b.capB ? 1 : 0), 0);
    // 機首と艦尾の2面だけが露出し、区画同士の継ぎ目は連続する。
    assert.equal(caps, 2);

    const capArea = trianglesArea(buildHullTriangles({ bands: shape.bands, beams: [] }))
      - trianglesArea(buildHullTriangles(bandsOnly(shape)));
    const expected = Math.abs(polygonArea(sectionOutline(nodeById(tree, 'nose').section, HULL_LOD_SAMPLES.near)))
      + Math.abs(polygonArea(sectionOutline(nodeById(tree, 'tail').section, HULL_LOD_SAMPLES.near)));
    assert.ok(Math.abs(capArea - expected) / expected < 1e-6, `${capArea} vs ${expected}`);
  });

  test('トラスと分離機構は外皮を持たず骨組みになる', () => {
    const tree = crewedAssembly(C.PLAYER_MAX_HP).tree;
    const shape = hullShapeOf(tree, 'near');
    const trusses = tree.edges.filter((e) => e.kind.kind === 'truss').length;
    assert.ok(trusses > 0);
    assert.equal(shape.beams.length, trusses);
    assert.equal(shape.bands.length, tree.edges.length - trusses);
    // 骨組みは閉じた箱の集まりなので、面積も三角形も 0 ではない。
    assert.ok(trianglesArea(buildHullTriangles({ bands: [], beams: shape.beams })) > 0);
  });

  test('既定の3設計が有限の頂点と三角形を生む', () => {
    for (const assembly of [
      crewedAssembly(C.PLAYER_MAX_HP),
      orbitalBaseAssembly(C.BASE_MAX_HP),
      hostileAssembly(C.ENEMY_MAX_HP),
    ]) {
      for (const lod of ['near', 'far'] as const) {
        const { positions, indices } = buildHullTriangles(hullShapeOf(assembly.tree, lod));
        assert.ok(positions.length > 0 && indices.length > 0);
        assert.ok(positions.every(Number.isFinite));
        // 遠距離の分割数は近距離より少ない。
        if (lod === 'far') {
          const near = buildHullTriangles(hullShapeOf(assembly.tree, 'near'));
          assert.ok(indices.length < near.indices.length);
        }
      }
    }
  });
}
