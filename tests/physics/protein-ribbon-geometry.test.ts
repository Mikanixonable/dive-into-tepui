import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { buildProteinRibbon, type ProteinRenderSource } from '../../src/render/protein-ribbon';
import { proteinRibbonColor, type ProteinSecondaryKind } from '../../src/render/protein-ribbon-color';
import { test } from './harness';
import { testProteinAssetBundleFor } from './protein-test-assets';

/** THREE.Mesh へ型を絞り込む。 */
function isMesh(object: THREE.Object3D): object is THREE.Mesh {
  return object instanceof THREE.Mesh;
}

/** 生成済み asset を描画 source として返す。 */
function sourceFor(id: 'pdb-5i4r' | 'pdb-1mbn-myoglobin'): ProteinRenderSource {
  return testProteinAssetBundleFor(id);
}

/** 色計算だけを対象にした合成 source を作る。ribbon mesh には触れない。 */
function straightSource(
  secondary: readonly ProteinSecondaryKind[],
  chains: readonly string[] = secondary.map(() => 'A'),
): ProteinRenderSource {
  const source = sourceFor('pdb-1mbn-myoglobin');
  return {
    ...source,
    backbone: {
      backboneCount: secondary.length,
      backboneCoordinates: secondary.flatMap((_, index) => [0, 0, index]),
      backboneSecondary: secondary,
      backboneChains: chains,
      backboneEntities: secondary.map(() => 1),
      backboneBFactors: secondary.map((_, index) => index),
    },
  };
}

/** Ribbon タグを持つ mesh を集める。 */
function ribbonMeshes(object: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  object.traverse((child) => {
    if (isMesh(child) && child.userData.proteinRibbon === true) meshes.push(child);
  });
  return meshes;
}

/** geometry の有限性、法線、縮退面、材質を検査する。 */
function assertMeshQuality(mesh: THREE.Mesh): void {
  const positions = mesh.geometry.getAttribute('position');
  const normals = mesh.geometry.getAttribute('normal');
  const colors = mesh.geometry.getAttribute('color');
  assert.equal(normals.count, positions.count);
  assert.equal(colors.count, positions.count);

  for (let index = 0; index < positions.count; index++) {
    for (const value of [
      positions.getX(index), positions.getY(index), positions.getZ(index),
      normals.getX(index), normals.getY(index), normals.getZ(index),
      colors.getX(index), colors.getY(index), colors.getZ(index),
    ]) {
      assert.ok(Number.isFinite(value));
    }
    const normalLength = Math.hypot(normals.getX(index), normals.getY(index), normals.getZ(index));
    assert.ok(normalLength > 0.999 && normalLength < 1.001);
  }

  const index = mesh.geometry.getIndex();
  assert.ok(index);
  for (let offset = 0; offset + 2 < index.count; offset += 3) {
    const first = new THREE.Vector3().fromBufferAttribute(positions, index.getX(offset));
    const second = new THREE.Vector3().fromBufferAttribute(positions, index.getX(offset + 1));
    const third = new THREE.Vector3().fromBufferAttribute(positions, index.getX(offset + 2));
    const doubledArea = second.sub(first).cross(third.sub(first)).length();
    assert.ok(doubledArea > 2e-10);
  }

  if (!(mesh.material instanceof THREE.MeshStandardNodeMaterial)) {
    throw new Error('Ribbon material is not a standard node material');
  }
  assert.equal(mesh.material.metalness, 0);
  assert.equal(mesh.material.roughness, 0.68);
  assert.equal(mesh.material.side, THREE.DoubleSide);
}

/** 生成した Ribbon の所有リソースを破棄する。material は最初の mesh だけが持つ。 */
function disposeRibbon(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (!isMesh(child)) return;
    if (child.userData.ownsGeometry) child.geometry.dispose();
    if (child.userData.ownsMaterial) {
      if (Array.isArray(child.material)) {
        for (const material of child.material) material.dispose();
      } else {
        child.material.dispose();
      }
    }
  });
}

/** 指定値が許容差内かを検査する。 */
function assertNear(actual: number, expected: number, tolerance = 1e-6): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${expected} ± ${tolerance}, received ${actual}`,
  );
}

/** タンパク質 Ribbon の仕様テストを登録する。 */
export function register(): void {
  test('protein ribbon geometry: real assets keep every vertex finite, one mesh per chain, no triangle lost', () => {
    for (const id of ['pdb-5i4r', 'pdb-1mbn-myoglobin'] as const) {
      const source = sourceFor(id);
      const object = buildProteinRibbon(source, 'chain');
      const meshes = ribbonMeshes(object);
      const chainCount = new Set(source.structure.ribbon.mesh.chain).size;
      assert.equal(meshes.length, chainCount);
      for (const mesh of meshes) assertMeshQuality(mesh);

      const triangles = meshes.reduce((sum, mesh) => sum + (mesh.geometry.getIndex()?.count ?? 0) / 3, 0);
      assert.equal(triangles, source.structure.ribbon.mesh.index.length / 3);
      disposeRibbon(object);
    }
  });

  test('protein ribbon geometry: mesh count matches chain count, material is shared', () => {
    for (const id of ['pdb-5i4r', 'pdb-1mbn-myoglobin'] as const) {
      const source = sourceFor(id);
      const object = buildProteinRibbon(source, 'chain');
      const meshes = ribbonMeshes(object);
      const chainCount = new Set(source.backbone.backboneChains).size;
      assert.equal(meshes.length, chainCount);
      const materials = new Set(meshes.map((mesh) => mesh.material));
      assert.equal(materials.size, 1);
      const owners = meshes.filter((mesh) => mesh.userData.ownsMaterial === true);
      assert.equal(owners.length, 1);
      disposeRibbon(object);
    }
  });

  test('protein ribbon geometry: chain colors use deterministic Set2 chain mapping', () => {
    const secondary = Array<ProteinSecondaryKind>(9).fill('coil');
    const chains = Array.from({ length: 9 }, (_, index) => String.fromCharCode(65 + index));
    const source = straightSource(secondary, chains);
    const SET2 = [
      0x66c2a5, 0xfc8d62, 0x8da0cb, 0xe78ac3,
      0xa6d854, 0xffd92f, 0xe5c494, 0xb3b3b3,
    ] as const;
    for (let index = 0; index < SET2.length; index++) {
      const color = proteinRibbonColor(source, index, 'chain');
      const expected = new THREE.Color(SET2[index]);
      assertNear(color.r, expected.r);
      assertNear(color.g, expected.g);
      assertNear(color.b, expected.b);
    }
    // 9鎖目(index 8, chain 'I')は8色パレットの先頭へ循環する。
    assert.deepEqual(proteinRibbonColor(source, 8, 'chain'), proteinRibbonColor(source, 0, 'chain'));
  });

  test('protein ribbon geometry: existing ribbon color calculations remain unchanged', () => {
    const source = straightSource(['helix', 'helix']);
    const expectations = [
      ['chain', new THREE.Color(0x66c2a5)],
      ['b-factor', new THREE.Color().setHSL(0.66, 0.86, 0.56)],
      ['rainbow', new THREE.Color().setHSL(0.66, 0.86, 0.56)],
      ['secondary-structure', new THREE.Color(0xe85d75)],
      ['component', new THREE.Color().setHSL(0, 0.78, 0.56)],
    ] as const;
    for (const [mode, expected] of expectations) {
      const color = proteinRibbonColor(source, 0, mode);
      assertNear(color.r, expected.r);
      assertNear(color.g, expected.g);
      assertNear(color.b, expected.b);
    }
  });

  test('protein ribbon geometry: component colors stay distinct beyond the old 6-color palette', () => {
    const source = testProteinAssetBundleFor('pdb-6n2y-atp-synthase');
    const roleCount = new Set(source.semantic.components.map((component) => component.role)).size;
    assert.ok(roleCount > 6, 'fixture should exercise more roles than the retired fixed palette held');

    const colorsByRole = new Map<string, THREE.Color>();
    for (const component of source.semantic.components) {
      const chain = component.chains[0]!;
      const index = source.backbone.backboneChains.indexOf(chain);
      colorsByRole.set(component.role, proteinRibbonColor(source, index, 'component'));
    }
    const seen = new Set<string>();
    for (const color of colorsByRole.values()) {
      const key = color.getHexString();
      assert.ok(!seen.has(key), `component color collided at ${key}`);
      seen.add(key);
    }
  });
}
