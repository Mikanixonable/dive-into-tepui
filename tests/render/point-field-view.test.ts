// point-field-view.ts の回帰テスト。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { PointFieldView } from '../../src/render/celestial/point-field-view';
import { FloatingOrigin } from '../../src/render/camera/floating-origin';
import { pointPositionAt, type PointElements } from '../../src/physics/point-orbit';
import { mulberry32 } from '../../src/math/random';
import { v3 } from '../../src/math/vec3';

// 小惑星帯ほどの軌道に散らばる count 点。
function points(count: number): readonly PointElements[] {
  const random = mulberry32(7);
  return Array.from({ length: count }, () => ({
    a: (2 + random()) * 1.496e11, e: random() * 0.2, inc: random() * 0.3,
    raan: random() * 6, lonPeri: random() * 6, l0: random() * 6, meanMotion: 2e-8 * (1 + random()),
  }));
}

// シーンへ置かれた点群の InstancedMesh。
function meshOf(scene: THREE.Scene): THREE.InstancedMesh {
  const mesh = scene.children.find((child) => (child as THREE.InstancedMesh).isInstancedMesh);
  if (mesh === undefined) throw new Error('点群の InstancedMesh が無い');
  return mesh as THREE.InstancedMesh;
}

export function register(): void {
  test('point-field-view: 送る範囲は書いた枠を覆い、表示時刻を止めて引き直しが一巡すれば全点がその時刻の位置にある', () => {
    const elements = points(101);
    const scene = new THREE.Scene();
    const view = new PointFieldView([{ id: 'belt', points: elements, drawRadius: 1, color: 0xffffff }]);
    view.build(scene);
    const fo = new FloatingOrigin(v3(), v3());
    const star = v3();
    view.sync(true, fo, 0, star, 1);
    const mesh = meshOf(scene);
    const matrices = mesh.instanceMatrix;
    // 表示時刻を進めながら折り返しを何度か跨ぎ、最後は止めて一巡させる。
    const t = 3.2e7;
    for (let frame = 0; frame < 40; frame++) {
      const before = Float32Array.from(matrices.array as Float32Array);
      const version = matrices.version;
      view.sync(true, fo, frame < 30 ? t - (30 - frame) * 1e5 : t, star, 1);
      // 書き換わった要素は、そのフレームに送る範囲の中にだけある。
      const after = matrices.array as Float32Array;
      for (let i = 0; i < after.length; i++) {
        if (after[i] === before[i]) continue;
        assert.ok(matrices.version > version, `frame ${frame}: 書き換えたのに送らない`);
        assert.ok(matrices.updateRanges.some((r) => i >= r.start && i < r.start + r.count),
          `frame ${frame}: 要素 ${i} が送る範囲の外`);
      }
    }
    // 一巡した後は全点が t の位置にある。
    const position = new THREE.Vector3();
    const matrix = new THREE.Matrix4();
    for (const [index, element] of elements.entries()) {
      mesh.getMatrixAt(index, matrix);
      position.setFromMatrixPosition(matrix);
      const expected = pointPositionAt(element, t);
      assert.ok(Math.abs(position.x - expected.x) <= Math.abs(expected.x) * 1e-6 + 1, `点 ${index} の x`);
      assert.ok(Math.abs(position.y - expected.y) <= Math.abs(expected.y) * 1e-6 + 1, `点 ${index} の y`);
      assert.ok(Math.abs(position.z - expected.z) <= Math.abs(expected.z) * 1e-6 + 1, `点 ${index} の z`);
    }
    // 表示時刻が止まったまま全点を引き直し終えたら、もう送らない。
    const settled = matrices.version;
    view.sync(true, fo, t, star, 1);
    assert.equal(matrices.version, settled);
    view.dispose();
  });
}
