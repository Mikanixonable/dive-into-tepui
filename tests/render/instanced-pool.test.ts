// InstancedPool が容量全体ではなく、CPU側で実際に書き換えた属性範囲だけを GPU 更新対象として
// 宣言することを固定する。renderer を要さず BufferAttribute の version/updateRanges だけを見る。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { InstancedPool } from '../../src/render/instanced-pool';
import { INSTANCE_THERMAL_ATTRIBUTE } from '../../src/render/thermal-emissive';

function firstRange(attribute: THREE.BufferAttribute): { start: number; count: number } {
  const range = attribute.updateRanges[0];
  assert.ok(range !== undefined, 'update range が無い');
  assert.equal(attribute.updateRanges.length, 1, 'update range が1区間に畳まれていない');
  return range;
}

export function register(): void {
  test('instanced pool: matrix/color は使用枠までだけを update range にする', () => {
    const scene = new THREE.Scene();
    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshBasicMaterial();
    const pool = new InstancedPool(scene, geometry, material, 8, true);
    const first = new THREE.Object3D();
    const second = new THREE.Object3D();

    pool.beginFrame();
    pool.push(first, new THREE.Color(0xff0000));
    pool.push(second, new THREE.Color(0x00ff00));
    pool.endFrame();

    const mesh = scene.children[0] as THREE.InstancedMesh;
    assert.deepEqual(firstRange(mesh.instanceMatrix), { start: 0, count: 2 * 16 });
    assert.ok(mesh.instanceColor !== null);
    assert.deepEqual(firstRange(mesh.instanceColor), { start: 0, count: 2 * 3 });
    pool.dispose();
    geometry.dispose();
    material.dispose();
  });

  test('instanced pool: 個体数が減った枠だけ PARKED 更新し、空の次フレームは転送を要求しない', () => {
    const scene = new THREE.Scene();
    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshBasicMaterial();
    const pool = new InstancedPool(scene, geometry, material, 8);
    const object = new THREE.Object3D();

    pool.beginFrame();
    pool.push(object);
    pool.endFrame();
    const mesh = scene.children[0] as THREE.InstancedMesh;

    pool.beginFrame();
    pool.endFrame();
    assert.deepEqual(firstRange(mesh.instanceMatrix), { start: 0, count: 16 });
    const parkedVersion = mesh.instanceMatrix.version;

    pool.beginFrame();
    pool.endFrame();
    assert.equal(mesh.instanceMatrix.version, parkedVersion, '空のままのフレームで matrix 転送を再要求した');
    pool.dispose();
    geometry.dispose();
    material.dispose();
  });

  test('instanced pool: thermal は値が変わった instance の範囲だけ更新する', () => {
    const scene = new THREE.Scene();
    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshBasicMaterial();
    const pool = new InstancedPool(scene, geometry, material, 8, false, 0, true);
    const unchanged = new THREE.Object3D();
    const changed = new THREE.Object3D();
    changed.userData.thermalTemperature = 320;
    changed.userData.thermalDeviation = 15;
    changed.userData.thermalEmissivity = 0.8;

    pool.beginFrame();
    pool.push(unchanged);
    pool.push(changed);
    pool.endFrame();

    const thermal = geometry.getAttribute(INSTANCE_THERMAL_ATTRIBUTE);
    assert.ok(thermal !== undefined);
    assert.deepEqual(firstRange(thermal as THREE.BufferAttribute), { start: 3, count: 3 });
    pool.dispose();
    geometry.dispose();
    material.dispose();
  });
}
