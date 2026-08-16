// 3Dジオメトリの品質検証 (geometry-validator.ts) の単体テストおよび回帰テスト。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from './harness';
import { validateGeometry } from '../../src/render/geometry-validator';

export function register(): void {
  test('geometry: 密閉された立方体 (BoxGeometry) にオープンエッジおよび重複面が無いこと', () => {
    const box = new THREE.BoxGeometry(1, 1, 1);
    const res = validateGeometry(box);
    assert.equal(res.openEdgeCount, 0, '密閉ボックスにオープンエッジは存在しない');
    assert.equal(res.coplanarOverlapCount, 0, '密閉ボックスに Z-fighting ポリゴンは存在しない');
  });

  test('geometry: 密閉された球体 (SphereGeometry) にオープンエッジおよび重複面が無いこと', () => {
    const sphere = new THREE.SphereGeometry(1, 16, 12);
    const res = validateGeometry(sphere);
    assert.equal(res.openEdgeCount, 0, '密閉球体にオープンエッジは存在しない');
    assert.equal(res.coplanarOverlapCount, 0, '密閉球体に Z-fighting ポリゴンは存在しない');
  });

  test('geometry: 1面が開いた（穴のある）メッシュのオープンエッジを正しく検出できること', () => {
    // 1辺が開いた単一の平面
    const plane = new THREE.PlaneGeometry(1, 1);
    const res = validateGeometry(plane);
    assert.ok(res.openEdgeCount > 0, `平面メッシュの境界エッジが検出されるべき (検出数: ${res.openEdgeCount})`);
  });

  test('geometry: 同一平面上に重複配置されたポリゴンペア (Z-fighting) を正しく検出できること', () => {
    // 同一平面上に完全重なりで置いた2つの四角形
    const p1 = new THREE.PlaneGeometry(1, 1);
    const p2 = new THREE.PlaneGeometry(1, 1);

    // 2つの PlaneGeometry を単一の BufferGeometry に結合
    const pos1 = p1.attributes.position.array;
    const pos2 = p2.attributes.position.array;
    const combinedPos = new Float32Array(pos1.length + pos2.length);
    combinedPos.set(pos1, 0);
    combinedPos.set(pos2, pos1.length);

    const idx1 = Array.from(p1.index!.array);
    const idx2 = Array.from(p2.index!.array, (i) => Number(i) + 4);
    const combinedIdx = new Uint16Array([...idx1, ...idx2]);

    const combined = new THREE.BufferGeometry();
    combined.setAttribute('position', new THREE.BufferAttribute(combinedPos, 3));
    combined.setIndex(new THREE.BufferAttribute(combinedIdx, 1));

    const res = validateGeometry(combined);
    assert.ok(res.coplanarOverlapCount > 0, `重複ポリゴンペアが検出されるべき (検出数: ${res.coplanarOverlapCount})`);
  });
}
