import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { proteinAssetBundleFor } from '../../src/game/protein/protein-asset-loader';
import { validateGeometry } from '../../src/render/geometry-validator';
import { buildProteinRibbon, type ProteinBackboneAsset, type ProteinRenderSource } from '../../src/render/protein-ribbon';
import { proteinSecondaryKind, type ProteinSecondaryKind } from '../../src/render/protein-ribbon-color';
import { test } from './harness';

interface RibbonMeshInfo {
  readonly mesh: THREE.Mesh;
  readonly kind: ProteinSecondaryKind;
  readonly transition: boolean;
}

interface RibbonBoundary {
  readonly startCenter: THREE.Vector3;
  readonly startDirection: THREE.Vector3;
  readonly startVertices: number;
  readonly endCenter: THREE.Vector3;
  readonly endDirection: THREE.Vector3;
  readonly endVertices: number;
}

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

/** userData の値を二次構造型として検証する。 */
function secondaryKind(value: unknown): ProteinSecondaryKind {
  if (value === 'coil' || value === 'helix' || value === 'sheet') return value;
  throw new Error(`Invalid protein secondary kind: ${String(value)}`);
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

/** Ribbon タグを持つ mesh を構築順に集める。 */
function ribbonMeshes(object: THREE.Object3D): RibbonMeshInfo[] {
  const meshes: RibbonMeshInfo[] = [];
  object.traverse((child) => {
    if (!isMesh(child) || child.userData.proteinRibbon !== true) return;
    const value = child.userData.proteinSecondary;
    if (value === 'coil' || value === 'helix' || value === 'sheet') {
      meshes.push({ mesh: child, kind: value, transition: child.userData.proteinRibbonTransition === true });
    }
  });
  return meshes;
}

/** 指定した二次構造の最初の mesh を返す。 */
function meshForKind(object: THREE.Object3D, kind: ProteinSecondaryKind): THREE.Mesh {
  const found = ribbonMeshes(object).find((entry) => entry.kind === kind && !entry.transition);
  if (!found) throw new Error(`Ribbon has no ${kind} mesh`);
  return found.mesh;
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

/** 断面の幅方向を頂点配置から復元する。 */
function ringWidthDirection(mesh: THREE.Mesh, kind: ProteinSecondaryKind, ring: number): THREE.Vector3 {
  const vertices = SECTION_VERTICES[kind];
  return vertexRangeWidthDirection(mesh, kind, ring * vertices, vertices);
}

/** 連続する断面頂点から幅方向を復元する。 */
function vertexRangeWidthDirection(
  mesh: THREE.Mesh, kind: ProteinSecondaryKind, start: number, vertices: number,
): THREE.Vector3 {
  const center = vertexRangeCenter(mesh, start, vertices);
  if (kind !== 'sheet') {
    return geometryPoint(mesh, start).sub(center).normalize();
  }
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
function assertMeshQuality({ mesh }: { readonly mesh: THREE.Mesh }): void {
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

  if (!(mesh.material instanceof THREE.MeshStandardMaterial)) {
    throw new Error('Ribbon material is not standard');
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

/** 生成した Ribbon の所有リソースを破棄する。 */
function disposeRibbon(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (!isMesh(child)) return;
    child.geometry.dispose();
    if (Array.isArray(child.material)) {
      for (const material of child.material) material.dispose();
    } else {
      child.material.dispose();
    }
  });
}

/** 通常区間または遷移区間の両端断面を返す。 */
function meshBoundary({ mesh, kind, transition }: RibbonMeshInfo): RibbonBoundary {
  if (transition) {
    const fromKind = secondaryKind(mesh.userData.proteinTransitionFromKind);
    const toKind = secondaryKind(mesh.userData.proteinTransitionToKind);
    const fromVertices = Number(mesh.userData.proteinTransitionFromVertices);
    const toVertices = Number(mesh.userData.proteinTransitionToVertices);
    return {
      startCenter: vertexRangeCenter(mesh, 0, fromVertices),
      startDirection: vertexRangeWidthDirection(mesh, fromKind, 0, fromVertices),
      startVertices: fromVertices,
      endCenter: vertexRangeCenter(mesh, fromVertices, toVertices),
      endDirection: vertexRangeWidthDirection(mesh, toKind, fromVertices, toVertices),
      endVertices: toVertices,
    };
  }
  const vertices = SECTION_VERTICES[kind];
  const rings = mesh.geometry.getAttribute('position').count / vertices;
  return {
    startCenter: ringCenter(mesh, 0, vertices),
    startDirection: ringWidthDirection(mesh, kind, 0),
    startVertices: vertices,
    endCenter: ringCenter(mesh, rings - 1, vertices),
    endDirection: ringWidthDirection(mesh, kind, rings - 1),
    endVertices: vertices,
  };
}

/** 断面が全 sample と SSE 境界で180°反転しないことを検査する。 */
function assertFrameContinuity(object: THREE.Object3D): number {
  const meshes = ribbonMeshes(object);
  let continuousBoundaries = 0;
  let previous: { readonly info: RibbonMeshInfo; readonly boundary: RibbonBoundary } | null = null;
  for (const current of meshes) {
    if (!current.transition) {
      const vertices = SECTION_VERTICES[current.kind];
      const rings = current.mesh.geometry.getAttribute('position').count / vertices;
      for (let ring = 1; ring < rings; ring++) {
        assert.ok(
          ringWidthDirection(current.mesh, current.kind, ring - 1)
            .dot(ringWidthDirection(current.mesh, current.kind, ring)) >= 0,
        );
      }
    }

    const boundary = meshBoundary(current);
    if (current.transition) {
      const transitionLength = boundary.startCenter.distanceTo(boundary.endCenter);
      assert.ok(transitionLength > 0 && transitionLength <= 8);
      assert.ok(boundary.startDirection.dot(boundary.endDirection) >= 0);
    }
    if (previous && previous.info.mesh.userData.proteinComponent === current.mesh.userData.proteinComponent) {
      const distance: number = previous.boundary.endCenter.distanceTo(boundary.startCenter);
      assert.ok(distance <= 1e-5 || distance > 8);
      if (distance <= 1e-5) {
        continuousBoundaries++;
        assert.ok(previous.boundary.endDirection.dot(boundary.startDirection) >= 0);
      }
    }
    previous = { info: current, boundary };
  }
  return continuousBoundaries;
}

/** 全 Ribbon Mesh を1つの検証用 geometry へ結合する。 */
function combinedRibbonGeometry(object: THREE.Object3D): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const { mesh } of ribbonMeshes(object)) {
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
function assertOnlyChainEndsOpen(object: THREE.Object3D): void {
  const meshes = ribbonMeshes(object);
  let expectedOpenEdges = 0;
  let previous: { readonly info: RibbonMeshInfo; readonly boundary: RibbonBoundary } | null = null;
  for (const info of meshes) {
    const boundary = meshBoundary(info);
    const connected = previous
      && previous.info.mesh.userData.proteinComponent === info.mesh.userData.proteinComponent
      && previous.boundary.endCenter.distanceTo(boundary.startCenter) <= 1e-5;
    if (!connected) {
      if (previous) expectedOpenEdges += previous.boundary.endVertices;
      expectedOpenEdges += boundary.startVertices;
    }
    previous = { info, boundary };
  }
  if (previous) expectedOpenEdges += previous.boundary.endVertices;

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
    const helix = meshForKind(helixObject, 'helix');
    const sheet = meshForKind(sheetObject, 'sheet');
    const coil = meshForKind(coilObject, 'coil');

    for (const entry of [
      { mesh: helix, kind: 'helix' },
      { mesh: sheet, kind: 'sheet' },
      { mesh: coil, kind: 'coil' },
    ] as const) {
      assertMeshQuality(entry);
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

  test('protein ribbon geometry: real assets keep every interval finite and frame-continuous', () => {
    for (const id of ['pdb-5i4r', 'pdb-1mbn-myoglobin'] as const) {
      const source = sourceFor(id);
      const object = buildProteinRibbon(source, 'publication');
      const meshes = ribbonMeshes(object);
      const kinds = new Set(meshes.map((entry) => entry.kind));
      assert.ok(kinds.has('helix'));
      assert.ok(kinds.has('coil'));
      if (id === 'pdb-5i4r') assert.ok(kinds.has('sheet'));
      for (const entry of meshes) assertMeshQuality(entry);
      assert.ok(assertFrameContinuity(object) > 0);
      assertOnlyChainEndsOpen(object);

      const triangles = meshes.reduce(
        (sum, entry) => sum + (entry.mesh.geometry.getIndex()?.count ?? 0) / 3,
        0,
      );
      assert.equal(triangles, expectedTriangleCount(source.backbone));
      if (id === 'pdb-5i4r') assert.ok(triangles <= 260_000);
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
    const firstColors = new Map<string, THREE.Color>();
    for (const { mesh } of ribbonMeshes(first)) {
      const color = mesh.geometry.getAttribute('color');
      firstColors.set(
        String(mesh.userData.proteinComponent),
        new THREE.Color(color.getX(0), color.getY(0), color.getZ(0)),
      );
    }
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

    const firstKeys = ribbonMeshes(first).map(({ mesh }) => mesh.geometry.getAttribute('color').getX(0));
    const secondKeys = ribbonMeshes(second).map(({ mesh }) => mesh.geometry.getAttribute('color').getX(0));
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
      assertFirstColor(meshForKind(object, 'helix'), expected);
      disposeRibbon(object);
    }
  });
}
