import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as THREE from 'three/webgpu';
import { proteinAssetBundleFor, type ProteinAssetId } from '../../src/game/protein/protein-asset-loader';
import { ProteinRibbonCollisionGeometry } from '../../src/game/protein/protein-ribbon-collision';
import type { ProteinRenderSource } from '../../src/render/protein-enemy-ship';
import { buildProteinCollisionRibbon } from '../../src/render/protein-ribbon';
import { v3 } from '../../src/physics/vec3';
import { test } from './harness';

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
    triangles: 139932,
    fingerprint: '209d215e15de3e62e0201223a2d5dfd0665571293b990428082341b45f599ebd',
    outerRadius: 65.6861769962617,
    representativePoint: [0.4531032542387643, 16.84963417053222, -41.489982604980455],
    representativeNormal: [-0.01757874371673807, 0.2780117806869385, 0.9604168040848823],
  },
  {
    assetId: 'pdb-1mbn-myoglobin',
    triangles: 18840,
    fingerprint: 'd5fa28e65e05c99586390c1871290fbadd5b1e184329e23b286fff8dfe9e8963',
    outerRadius: 23.668641777876882,
    representativePoint: [-17.425394694010414, -4.5192445119222, 7.836565017700195],
    representativeNormal: [-0.10213145028472966, 0.4269975732886829, 0.8984666044257369],
  },
];

// 指定したアセットの生成済みデータをリボン入力へまとめる。
function sourceFor(assetId: ProteinAssetId): ProteinRenderSource {
  const bundle = proteinAssetBundleFor(assetId);
  if (!bundle) throw new Error(`Missing protein asset bundle: ${assetId}`);
  return bundle;
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
