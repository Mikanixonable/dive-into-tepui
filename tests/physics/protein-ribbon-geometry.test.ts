import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { proteinAssetBundleFor } from '../../src/game/protein/protein-asset-loader';
import { validateGeometry } from '../../src/render/geometry-validator';
import {
  buildProteinRibbon,
  ribbonChainLayout,
  type ProteinBackboneAsset,
  type ProteinRenderSource,
  type RibbonChainSection,
} from '../../src/render/protein-ribbon';
import { proteinSecondaryKind, type ProteinSecondaryKind } from '../../src/render/protein-ribbon-color';
import { test } from './harness';

const SAMPLES_PER_RESIDUE = 12;
const SECTION_VERTICES: Readonly<Record<ProteinSecondaryKind, number>> = {
  coil: 12,
  helix: 12,
  sheet: 4,
};
const SET2 = [
  0x66c2a5, 0xfc8d62, 0x8da0cb, 0xe78ac3,
  0xa6d854, 0xffd92f, 0xe5c494, 0xb3b3b3,
] as const;

/** THREE.Mesh へ型を絞り込む。 */
function isMesh(object: THREE.Object3D): object is THREE.Mesh {
  return object instanceof THREE.Mesh;
}

/** 生成済み asset を描画 source として返す。 */
function sourceFor(id: 'pdb-5i4r' | 'pdb-1mbn-myoglobin'): ProteinRenderSource {
  const source = proteinAssetBundleFor(id);
  if (!source) throw new Error(`Missing protein asset: ${id}`);
  return source;
}

/** 直線主鎖と +X 側のカルボニル酸素を持つ合成 source を作る。 */
function straightSource(
  secondary: readonly ProteinSecondaryKind[],
  chains: readonly string[] = secondary.map(() => 'A'),
): ProteinRenderSource {
  const source = sourceFor('pdb-1mbn-myoglobin');
  const coordinates = secondary.flatMap((_, index) => [0, 0, index]);
  const oxygenCoordinates = secondary.flatMap((_, index) => [1, 0, index]);
  return {
    ...source,
    backbone: {
      backboneCount: secondary.length,
      backboneCoordinates: coordinates,
      backboneOCoordinates: oxygenCoordinates,
      backboneSecondary: secondary,
      backboneChains: chains,
      backboneEntities: secondary.map(() => 1),
      backboneBFactors: secondary.map((_, index) => index),
    },
  };
}

/** Ribbon タグを持つ mesh を、鎖の構築順(ribbonChainLayout と同じ順)で集める。 */
function ribbonMeshes(object: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  object.traverse((child) => {
    if (isMesh(child) && child.userData.proteinRibbon === true) meshes.push(child);
  });
  return meshes;
}

/** 唯一の Ribbon mesh を返す。単一鎖・単一区間の合成 source でのみ使う。 */
function soleRibbonMesh(object: THREE.Object3D): THREE.Mesh {
  const meshes = ribbonMeshes(object);
  if (meshes.length !== 1) throw new Error(`Expected exactly one ribbon mesh, found ${meshes.length}`);
  const mesh = meshes[0];
  if (!mesh) throw new Error('Expected exactly one ribbon mesh');
  return mesh;
}

/** 断面 ring の中心を頂点平均から求める。 */
function ringCenter(mesh: THREE.Mesh, ring: number, vertices: number): THREE.Vector3 {
  return vertexRangeCenter(mesh, ring * vertices, vertices);
}

/** 連続する頂点範囲の中心を頂点平均から求める。 */
function vertexRangeCenter(mesh: THREE.Mesh, start: number, vertices: number): THREE.Vector3 {
  const position = mesh.geometry.getAttribute('position');
  const result = new THREE.Vector3();
  for (let vertex = 0; vertex < vertices; vertex++) {
    result.add(new THREE.Vector3().fromBufferAttribute(position, start + vertex));
  }
  return result.multiplyScalar(1 / vertices);
}

/** 断面 ring の指定頂点を返す。 */
function ringPoint(mesh: THREE.Mesh, ring: number, vertex: number, vertices: number): THREE.Vector3 {
  return new THREE.Vector3().fromBufferAttribute(
    mesh.geometry.getAttribute('position'),
    ring * vertices + vertex,
  );
}

/** geometry の指定頂点を返す。 */
function geometryPoint(mesh: THREE.Mesh, vertex: number): THREE.Vector3 {
  return new THREE.Vector3().fromBufferAttribute(mesh.geometry.getAttribute('position'), vertex);
}

/** 連続する断面頂点から幅方向を復元する。sheet(4頂点)だけ対辺中点差で求める。 */
function vertexRangeWidthDirection(mesh: THREE.Mesh, vertices: number, start: number): THREE.Vector3 {
  const center = vertexRangeCenter(mesh, start, vertices);
  if (vertices !== 4) return geometryPoint(mesh, start).sub(center).normalize();
  const positive = geometryPoint(mesh, start).add(geometryPoint(mesh, start + 3));
  const negative = geometryPoint(mesh, start + 1).add(geometryPoint(mesh, start + 2));
  return positive.sub(negative).normalize();
}

/** 軸に沿った合成主鎖の断面幅と厚さを返す [Å]。 */
function straightRingDimensions(
  mesh: THREE.Mesh,
  kind: ProteinSecondaryKind,
  ring: number,
): { width: number; thickness: number } {
  const vertices = SECTION_VERTICES[kind];
  const points = Array.from(
    { length: vertices },
    (_, vertex) => ringPoint(mesh, ring, vertex, vertices),
  );
  return {
    width: Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x)),
    thickness: Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y)),
  };
}

/** 指定値が許容差内かを検査する。 */
function assertNear(actual: number, expected: number, tolerance = 1e-3): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${expected} ± ${tolerance}, received ${actual}`,
  );
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
    const first = geometryPoint(mesh, index.getX(offset));
    const second = geometryPoint(mesh, index.getX(offset + 1));
    const third = geometryPoint(mesh, index.getX(offset + 2));
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

/** 小さな合成 geometry が長手方向に穴を持たないことを検査する。 */
function assertOnlyEndRingsOpen(mesh: THREE.Mesh, kind: ProteinSecondaryKind): void {
  const validation = validateGeometry(mesh.geometry, { checkCoplanarOverlap: false });
  assert.equal(validation.openEdgeCount, SECTION_VERTICES[kind] * 2);
  assert.equal(validation.coplanarOverlapCount, 0);
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

/** 区間・遷移それぞれの、統合バッファ上での開始頂点数・終了頂点数を返す。 */
function sectionEdgeVertices(section: RibbonChainSection): { start: number; end: number } {
  if (section.transition) return { start: section.fromVertices, end: section.toVertices };
  return { start: section.ringVertices, end: section.ringVertices };
}

/**
 * 鎖ごとの mesh を ribbonChainLayout の区間列と突き合わせ、ring 単位の断面反転・
 * 区間境界の連続性を検査する。継続した境界の数を返す。
 */
function assertChainMeshLayout(mesh: THREE.Mesh, runs: readonly RibbonChainSection[][]): number {
  let offset = 0;
  let continuousBoundaries = 0;
  for (const run of runs) {
    let previous: { readonly endCenter: THREE.Vector3; readonly endDirection: THREE.Vector3 } | null = null;
    for (const section of run) {
      if (!section.transition) {
        for (let ring = 1; ring < section.ringCount; ring++) {
          assert.ok(
            vertexRangeWidthDirection(mesh, section.ringVertices, offset + (ring - 1) * section.ringVertices)
              .dot(vertexRangeWidthDirection(mesh, section.ringVertices, offset + ring * section.ringVertices)) >= 0,
          );
        }
      }
      const startVertices = section.transition ? section.fromVertices : section.ringVertices;
      const endVertices = section.transition ? section.toVertices : section.ringVertices;
      const startCenter = vertexRangeCenter(mesh, offset, startVertices);
      const startDirection = vertexRangeWidthDirection(mesh, startVertices, offset);
      const endOffset = section.transition ? offset + startVertices : offset + (section.ringCount - 1) * section.ringVertices;
      const endCenter = vertexRangeCenter(mesh, endOffset, endVertices);
      const endDirection = vertexRangeWidthDirection(mesh, endVertices, endOffset);

      if (section.transition) {
        const transitionLength = startCenter.distanceTo(endCenter);
        assert.ok(transitionLength > 0 && transitionLength <= 8);
        assert.ok(startDirection.dot(endDirection) >= 0);
      }
      if (previous) {
        const distance = previous.endCenter.distanceTo(startCenter);
        assertNear(distance, 0, 1e-5);
        assert.ok(previous.endDirection.dot(startDirection) >= 0);
        continuousBoundaries++;
      }
      previous = { endCenter, endDirection };
      offset += section.transition ? startVertices + endVertices : section.ringCount * section.ringVertices;
    }
  }
  assert.equal(offset, mesh.geometry.getAttribute('position').count);
  return continuousBoundaries;
}

/** 全 Ribbon Mesh を1つの検証用 geometry へ結合する。 */
function combinedRibbonGeometry(object: THREE.Object3D): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const mesh of ribbonMeshes(object)) {
    const position = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.getIndex();
    const vertexOffset = positions.length / 3;
    for (let vertex = 0; vertex < position.count; vertex++) {
      positions.push(position.getX(vertex), position.getY(vertex), position.getZ(vertex));
    }
    const indexCount = index?.count ?? position.count;
    for (let offset = 0; offset < indexCount; offset++) {
      indices.push(vertexOffset + (index ? index.getX(offset) : offset));
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return geometry;
}

/** 鎖端と8 Å超の欠損だけが open edge であることを検査する。 */
function assertOnlyChainEndsOpen(object: THREE.Object3D, layout: ReadonlyMap<string, RibbonChainSection[][]>): void {
  let expectedOpenEdges = 0;
  for (const runs of layout.values()) {
    for (const run of runs) {
      const first = run[0];
      const last = run[run.length - 1];
      if (!first || !last) continue;
      expectedOpenEdges += sectionEdgeVertices(first).start + sectionEdgeVertices(last).end;
    }
  }

  const geometry = combinedRibbonGeometry(object);
  const validation = validateGeometry(geometry, { checkCoplanarOverlap: false });
  geometry.dispose();
  assert.equal(validation.openEdgeCount, expectedOpenEdges);
}

/** asset の連続した Cα 間隔から12分割時の triangle 数を導く。 */
function expectedTriangleCount(backbone: ProteinBackboneAsset): number {
  const connected = (first: number, second: number): boolean => {
    if (backbone.backboneChains[first] !== backbone.backboneChains[second]) return false;
    const firstOffset = first * 3;
    const secondOffset = second * 3;
    return Math.hypot(
      backbone.backboneCoordinates[secondOffset]! - backbone.backboneCoordinates[firstOffset]!,
      backbone.backboneCoordinates[secondOffset + 1]! - backbone.backboneCoordinates[firstOffset + 1]!,
      backbone.backboneCoordinates[secondOffset + 2]! - backbone.backboneCoordinates[firstOffset + 2]!,
    ) <= 8;
  };
  let triangles = 0;
  for (let index = 1; index < backbone.backboneCount; index++) {
    if (!connected(index - 1, index)) continue;
    const secondary = backbone.backboneSecondary[index - 1]?.toLowerCase();
    const sectionEdges = secondary === 'sheet' || secondary === 'e' || secondary === 'beta-sheet' ? 4 : 12;
    triangles += sectionEdges * 2 * SAMPLES_PER_RESIDUE;
  }
  // SSE 変更直後の最初の1分割は、旧断面と新断面の辺数を足した遷移面へ置き換わる。
  for (let index = 1; index + 1 < backbone.backboneCount; index++) {
    if (!connected(index - 1, index) || !connected(index, index + 1)) continue;
    const previousKind = proteinSecondaryKind(backbone.backboneSecondary[index - 1]);
    const currentKind = proteinSecondaryKind(backbone.backboneSecondary[index]);
    if (previousKind === currentKind) continue;
    triangles += SECTION_VERTICES[previousKind] - SECTION_VERTICES[currentKind];
  }
  return triangles;
}

/** 頂点色の先頭値が期待色と一致することを検査する。 */
function assertFirstColor(mesh: THREE.Mesh, expected: THREE.Color): void {
  const color = mesh.geometry.getAttribute('color');
  assertNear(color.getX(0), expected.r, 1e-6);
  assertNear(color.getY(0), expected.g, 1e-6);
  assertNear(color.getZ(0), expected.b, 1e-6);
}

/** タンパク質 Ribbon の仕様テストを登録する。 */
export function register(): void {
  test('protein ribbon geometry: publication sections and beta arrow follow the specification', () => {
    const helixObject = buildProteinRibbon(straightSource(Array<ProteinSecondaryKind>(5).fill('helix')), 'publication');
    const sheetObject = buildProteinRibbon(straightSource(Array<ProteinSecondaryKind>(5).fill('sheet')), 'publication');
    const coilObject = buildProteinRibbon(straightSource(Array<ProteinSecondaryKind>(5).fill('coil')), 'publication');
    const helix = soleRibbonMesh(helixObject);
    const sheet = soleRibbonMesh(sheetObject);
    const coil = soleRibbonMesh(coilObject);

    for (const entry of [
      { mesh: helix, kind: 'helix' },
      { mesh: sheet, kind: 'sheet' },
      { mesh: coil, kind: 'coil' },
    ] as const) {
      assertMeshQuality(entry.mesh);
      assertOnlyEndRingsOpen(entry.mesh, entry.kind);
    }

    const helixStart = straightRingDimensions(helix, 'helix', 0);
    const helixEnd = straightRingDimensions(helix, 'helix', 4 * SAMPLES_PER_RESIDUE);
    assertNear(helixStart.width, 2);
    assertNear(helixStart.thickness, 0.4);
    assertNear(helixEnd.width, 2);
    assertNear(helixEnd.thickness, 0.4);

    const sheetStart = straightRingDimensions(sheet, 'sheet', 0);
    const sheetShaftEnd = straightRingDimensions(sheet, 'sheet', 2 * SAMPLES_PER_RESIDUE);
    const sheetMaximum = straightRingDimensions(sheet, 'sheet', 3 * SAMPLES_PER_RESIDUE);
    const sheetTip = straightRingDimensions(sheet, 'sheet', 4 * SAMPLES_PER_RESIDUE);
    assertNear(sheetStart.width, 2);
    assertNear(sheetShaftEnd.width, 2);
    assertNear(sheetMaximum.width, 4);
    assert.ok(sheetTip.width > 0 && sheetTip.width < 0.1);
    for (const section of [sheetStart, sheetShaftEnd, sheetMaximum, sheetTip]) {
      assertNear(section.thickness, 0.4);
    }

    const coilStart = straightRingDimensions(coil, 'coil', 0);
    assertNear(coilStart.width, 0.4);
    assertNear(coilStart.thickness, 0.4);

    disposeRibbon(helixObject);
    disposeRibbon(sheetObject);
    disposeRibbon(coilObject);
  });

  test('protein ribbon geometry: real assets keep every interval finite and frame-continuous, one mesh per chain', () => {
    for (const id of ['pdb-5i4r', 'pdb-1mbn-myoglobin'] as const) {
      const source = sourceFor(id);
      const object = buildProteinRibbon(source, 'publication');
      const layout = ribbonChainLayout(source);
      const meshes = ribbonMeshes(object);
      assert.equal(meshes.length, layout.size);

      const kinds = new Set<ProteinSecondaryKind>();
      let continuousBoundaries = 0;
      let index = 0;
      for (const runs of layout.values()) {
        const mesh = meshes[index]!;
        index++;
        assertMeshQuality(mesh);
        for (const run of runs) {
          for (const section of run) {
            if (!section.transition) kinds.add(section.kind);
            else { kinds.add(section.fromKind); kinds.add(section.toKind); }
          }
        }
        continuousBoundaries += assertChainMeshLayout(mesh, runs);
      }
      assert.ok(kinds.has('helix'));
      assert.ok(kinds.has('coil'));
      if (id === 'pdb-5i4r') assert.ok(kinds.has('sheet'));
      assert.ok(continuousBoundaries > 0);
      assertOnlyChainEndsOpen(object, layout);

      const triangles = meshes.reduce((sum, mesh) => sum + (mesh.geometry.getIndex()?.count ?? 0) / 3, 0);
      assert.equal(triangles, expectedTriangleCount(source.backbone));
      if (id === 'pdb-5i4r') assert.ok(triangles <= 260_000);
      disposeRibbon(object);
    }
  });

  test('protein ribbon geometry: mesh count matches chain count, material is shared', () => {
    for (const id of ['pdb-5i4r', 'pdb-1mbn-myoglobin'] as const) {
      const source = sourceFor(id);
      const object = buildProteinRibbon(source, 'publication');
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

  test('protein ribbon geometry: publication colors use deterministic Set2 chain mapping', () => {
    const secondary = Array<ProteinSecondaryKind>(18).fill('coil');
    const chains = Array.from({ length: 9 }, (_, index) => (
      [String.fromCharCode(65 + index), String.fromCharCode(65 + index)]
    )).flat();
    const source = straightSource(secondary, chains);
    const first = buildProteinRibbon(source, 'publication');
    const second = buildProteinRibbon(source, 'publication');
    const chainOrder = [...ribbonChainLayout(source).keys()];
    const firstMeshes = ribbonMeshes(first);
    assert.equal(firstMeshes.length, chainOrder.length);

    const firstColors = new Map<string, THREE.Color>();
    chainOrder.forEach((chain, index) => {
      const color = firstMeshes[index]!.geometry.getAttribute('color');
      firstColors.set(chain, new THREE.Color(color.getX(0), color.getY(0), color.getZ(0)));
    });
    assert.equal(firstColors.size, 9);
    for (let index = 0; index < SET2.length; index++) {
      const chain = String.fromCharCode(65 + index);
      const actual = firstColors.get(chain);
      assert.ok(actual);
      const expected = new THREE.Color(SET2[index]);
      assertNear(actual.r, expected.r, 1e-6);
      assertNear(actual.g, expected.g, 1e-6);
      assertNear(actual.b, expected.b, 1e-6);
    }
    assert.deepEqual(firstColors.get('I'), firstColors.get('A'));

    const secondMeshes = ribbonMeshes(second);
    const firstKeys = firstMeshes.map((mesh) => mesh.geometry.getAttribute('color').getX(0));
    const secondKeys = secondMeshes.map((mesh) => mesh.geometry.getAttribute('color').getX(0));
    assert.deepEqual(secondKeys, firstKeys);
    disposeRibbon(first);
    disposeRibbon(second);
  });

  test('protein ribbon geometry: existing ribbon color calculations remain unchanged', () => {
    const source = straightSource(['helix', 'helix']);
    const expectations = [
      ['chain', new THREE.Color().setHSL(0.02, 0.78, 0.56)],
      ['b-factor', new THREE.Color().setHSL(0.66, 0.86, 0.56)],
      ['entity', new THREE.Color().setHSL(0.04, 0.78, 0.56)],
      ['rainbow', new THREE.Color().setHSL(0.66, 0.86, 0.56)],
      ['secondary-structure', new THREE.Color(0xe85d75)],
      ['component-role', new THREE.Color(0x4fc3f7)],
    ] as const;
    for (const [mode, expected] of expectations) {
      const object = buildProteinRibbon(source, mode);
      assertFirstColor(soleRibbonMesh(object), expected);
      disposeRibbon(object);
    }
  });
}
