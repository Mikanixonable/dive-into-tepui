import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as THREE from 'three/webgpu';
import type { ProteinAssetId } from '../../src/game/protein/protein-asset-loader';
import { ProteinRibbonCollisionGeometry } from '../../src/game/protein/protein-ribbon-collision';
import type { ProteinRenderSource } from '../../src/render/protein-enemy-ship';
import { buildProteinCollisionRibbon } from '../../src/render/protein-ribbon';
import { v3 } from '../../src/math/vec3';
import { test } from '../harness';
import { testProteinAssetBundleFor } from '../protein-test-assets';

interface RibbonCharacterization {
  readonly assetId: ProteinAssetId;
  readonly triangles: number;
  readonly fingerprint: string;
  readonly outerRadius: number;
  readonly representativePoint: readonly [number, number, number];
  readonly representativeNormal: readonly [number, number, number];
}

const RIBBON_CHARACTERIZATIONS: readonly RibbonCharacterization[] = [
  {
    assetId: 'pdb-5i4r',
    triangles: 145788,
    fingerprint: '88e5504f9656d111ddfe5ab05ea2dc79da72c60e5ad5f406abf93f4aae93cbb3',
    outerRadius: 65.50115811221157,
    representativePoint: [0.45506499210993434, 16.848959604899083, -41.489799499511705],
    representativeNormal: [-0.017157254603796024, 0.2778925277004757, 0.9604589380409246],
  },
  {
    assetId: 'pdb-1mbn-myoglobin',
    triangles: 17312,
    fingerprint: '88321ae2ccdd33e187bcd955971b3d2583f96289080917b15b85be94ca4c4017',
    outerRadius: 23.556818522249703,
    representativePoint: [-17.416152318318684, -4.518124103546143, 7.83454688390096],
    representativeNormal: [-0.08705777272643374, 0.4140586810736896, 0.9060774541039133],
  },
];

// 指定したアセットの生成済みデータをリボン入力へまとめる。
function sourceFor(assetId: ProteinAssetId): ProteinRenderSource {
  return testProteinAssetBundleFor(assetId);
}

// typed array の実バイト列をハッシュ入力として返す。
function typedArrayBytes(value: ArrayBufferView): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

// リボンの走査順に二次構造文字列と geometry の実バイト列を記録する。
function ribbonFingerprint(root: THREE.Object3D): { triangles: number; fingerprint: string } {
  const hash = createHash('sha256');
  let triangles = 0;
  root.updateMatrixWorld(true);
  const rootInverse = root.matrixWorld.clone().invert();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || object.userData.proteinRibbon !== true) return;
    const positions = object.geometry.getAttribute('position');
    const index = object.geometry.index;
    const localMatrix = rootInverse.clone().multiply(object.matrixWorld);
    const localPositions = new Float32Array(positions.count * 3);
    const point = new THREE.Vector3();
    for (let vertex = 0; vertex < positions.count; vertex++) {
      point.fromBufferAttribute(positions, vertex).applyMatrix4(localMatrix);
      localPositions[vertex * 3] = point.x;
      localPositions[vertex * 3 + 1] = point.y;
      localPositions[vertex * 3 + 2] = point.z;
    }
    const secondary = typeof object.userData.proteinSecondary === 'string'
      ? object.userData.proteinSecondary : '';
    hash.update(secondary, 'utf8');
    hash.update(typedArrayBytes(localPositions));
    if (index) {
      hash.update(typedArrayBytes(index.array));
      triangles += index.count / 3;
    }
  });
  return { triangles, fingerprint: hash.digest('hex') };
}

// characterization 用に生成した geometry と material を解放する。
function disposeRibbon(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    if (Array.isArray(object.material)) {
      for (const material of object.material) material.dispose();
    } else {
      object.material.dispose();
    }
  });
}

export function register(): void {
  test('protein ribbon collision: uses tagged mesh triangles instead of the outer sphere', () => {
    const identity = { x: 0, y: 0, z: 0, w: 1 };
    const root = new THREE.Group();
    const geometry = new THREE.PlaneGeometry(2, 2);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.userData.proteinRibbon = true;
    root.add(mesh);

    const collision = new ProteinRibbonCollisionGeometry(root, 1);
    const hit = collision.testSphereCollision(v3(0, 0, 0.1), 0.2, v3(), identity);
    assert.ok(hit, 'a sphere overlapping the ribbon plane should hit');
    assert.ok(Math.abs(hit!.point.z) < 1e-9, 'the reported point should lie on the ribbon mesh');

    const miss = collision.testSphereCollision(v3(0, 0, 3), 0.2, v3(), identity);
    assert.equal(miss, null, 'a sphere outside the ribbon mesh should miss');

    const swept = collision.testSweptSphereCollision(
      v3(0, 0, 2), v3(0, 0, -2), 0.2,
      { r: v3() }, { r: v3() }, identity,
    );
    assert.ok(swept, 'a sphere crossing the ribbon between frames should hit');
    assert.ok(swept!.toi > 0 && swept!.toi < 1, 'the swept hit should report an interior toi');

    geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  });

  test('protein ribbon collision: fixed asset geometry keeps its characterization', () => {
    for (const expected of RIBBON_CHARACTERIZATIONS) {
      const root = buildProteinCollisionRibbon(sourceFor(expected.assetId), 'chain');
      const fingerprint = ribbonFingerprint(root);
      const collision = new ProteinRibbonCollisionGeometry(root, 1);
      assert.equal(fingerprint.triangles, expected.triangles, `${expected.assetId} triangle count`);
      assert.equal(fingerprint.fingerprint, expected.fingerprint, `${expected.assetId} geometry fingerprint`);
      assert.equal(collision.outerRadius, expected.outerRadius, `${expected.assetId} outer radius`);

      const point = v3(...expected.representativePoint);
      const normal = v3(...expected.representativeNormal);
      const hit = collision.testSphereCollision(
        point, 1e-3, v3(), { x: 0, y: 0, z: 0, w: 1 },
      );
      assert.ok(hit, `${expected.assetId} representative triangle should be hittable`);

      for (const center of [
        v3(expected.outerRadius * 3, 0, 0), v3(-expected.outerRadius * 3, 0, 0),
        v3(0, expected.outerRadius * 3, 0), v3(0, -expected.outerRadius * 3, 0),
        v3(0, 0, expected.outerRadius * 3), v3(0, 0, -expected.outerRadius * 3),
      ]) {
        assert.equal(
          collision.testSphereCollision(center, 1e-3, v3(), { x: 0, y: 0, z: 0, w: 1 }),
          null,
          `${expected.assetId} outer-axis point should miss`,
        );
      }

      const previous = v3(
        point.x - normal.x, point.y - normal.y, point.z - normal.z,
      );
      const current = v3(
        point.x + normal.x, point.y + normal.y, point.z + normal.z,
      );
      const swept = collision.testSweptSphereCollision(
        previous, current, 1e-3,
        { r: v3() }, { r: v3() }, { x: 0, y: 0, z: 0, w: 1 },
      );
      assert.ok(swept, `${expected.assetId} representative triangle should be crossed`);
      assert.equal(swept?.toi, 0.49951171875, `${expected.assetId} swept toi`);
      disposeRibbon(root);
    }
  });
}
