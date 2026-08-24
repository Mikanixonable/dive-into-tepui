// タンパク質の表示用 Cartoon と衝突判定用リボンを生成する。
import * as THREE from 'three/webgpu';
import type { ProteinAssetDefinition, ProteinMotionAsset } from '../game/protein/protein-schema';
import type { ProteinDisplayAsset } from '../game/protein/protein-display-asset';
import type { ProteinRibbonColorMode } from '../game/protein/protein-display';
import {
  proteinRibbonColor,
  proteinSecondaryKind,
  type ProteinSecondaryKind,
} from './protein-ribbon-color';
import {
  attachProteinResidueBinding,
  proteinStandardMaterial,
  type ProteinMotionBinding,
} from './protein-motion-material';
export interface ProteinBackboneAsset {
  readonly backboneCount: number;
  readonly backboneCoordinates: readonly number[];
  /** カルボニル酸素の座標。Ribbon の幅方向を定める。 */
  readonly backboneOCoordinates?: readonly number[];
  readonly backboneSecondary: readonly string[];
  readonly backboneChains: readonly string[];
  readonly backboneEntities: readonly number[];
  readonly backboneBFactors: readonly number[];
}
export interface ProteinRenderSource {
  readonly semantic: ProteinAssetDefinition;
  readonly motion: ProteinMotionAsset;
  readonly backbone: ProteinBackboneAsset;
  readonly structure: ProteinDisplayAsset;
}

// PDB 座標系 [Å] で断面寸法と長手方向の分割数を定める。
const RIBBON_SUBDIVISIONS = 12;
const PUBLICATION_THICKNESS = 0.4;

interface BackboneRun {
  readonly points: THREE.Vector3[];
  readonly startIndex: number;
}


interface SecondarySpan {
  readonly kind: ProteinSecondaryKind;
  readonly start: number;
  readonly end: number;
}
interface RibbonSample {
  readonly center: THREE.Vector3;
  readonly tangent: THREE.Vector3;
  readonly widthDirection: THREE.Vector3;
  readonly thicknessDirection: THREE.Vector3;
  readonly sourceIndex: number;
  readonly residuePosition: number;
  readonly residueA: number;
  readonly residueB: number;
  readonly residueT: number;
}

/** 主鎖を鎖境界と欠損で分割する。 */
function backboneRuns(backbone: ProteinBackboneAsset): BackboneRun[] {
  const runs: BackboneRun[] = [];
  let current: { points: THREE.Vector3[]; startIndex: number } | null = null;
  // 8 Å を超える Cα 間隔は欠損として扱い、曲線で架橋しない。
  for (let index = 0; index < backbone.backboneCount; index++) {
    const offset = index * 3;
    const point = new THREE.Vector3(
      backbone.backboneCoordinates[offset]!, backbone.backboneCoordinates[offset + 1]!, backbone.backboneCoordinates[offset + 2]!,
    );
    const previous = current?.points[current.points.length - 1];
    const split = !current || !previous || point.distanceTo(previous) > 8
      || backbone.backboneChains[index] !== backbone.backboneChains[index - 1];
    if (split) {
      const nextRun = { points: [], startIndex: index };
      current = nextRun;
      runs.push(nextRun);
    }
    if (!current) continue;
    current.points.push(point);
  }
  return runs;
}

/** 連続した主鎖を二次構造ごとの共有境界付き区間へ分ける。 */
function secondarySpans(backbone: ProteinBackboneAsset, run: BackboneRun): SecondarySpan[] {
  const spans: SecondarySpan[] = [];
  let start = 0;
  let kind = proteinSecondaryKind(backbone.backboneSecondary[run.startIndex]);
  // 境界 residue を両区間へ含め、中心線を同じ座標で接続する。
  for (let local = 1; local < run.points.length; local++) {
    const nextKind = proteinSecondaryKind(backbone.backboneSecondary[run.startIndex + local]);
    if (nextKind === kind) continue;
    spans.push({ kind, start, end: local });
    start = local;
    kind = nextKind;
  }
  spans.push({ kind, start, end: run.points.length - 1 });
  return spans;
}

/** 指定 residue のカルボニル酸素座標を取得する。 */
function backboneO(backbone: ProteinBackboneAsset, index: number, fallback: THREE.Vector3): THREE.Vector3 {
  const coordinates = backbone.backboneOCoordinates;
  const offset = index * 3;
  if (!coordinates || offset + 2 >= coordinates.length) return fallback.clone();
  return new THREE.Vector3(coordinates[offset]!, coordinates[offset + 1]!, coordinates[offset + 2]!);
}

/** ベクトルを正規化し、長さが不足するときは代替方向を返す。 */
function normalizedOr(value: THREE.Vector3, fallback: THREE.Vector3): THREE.Vector3 {
  return value.lengthSq() > 1e-8 ? value.normalize() : fallback.clone();
}

/** 前断面の幅方向を現在の接線へ平行移動する。 */
function transportedDirection(
  previousTangent: THREE.Vector3 | null,
  previousWidth: THREE.Vector3 | null,
  tangent: THREE.Vector3,
): THREE.Vector3 | null {
  if (!previousTangent || !previousWidth) return null;
  const transported = previousWidth.clone()
    .applyQuaternion(new THREE.Quaternion().setFromUnitVectors(previousTangent, tangent))
    .projectOnPlane(tangent);
  return transported.lengthSq() > 1e-8 ? transported.normalize() : null;
}

/** 曲線上に断面中心と反転しない直交フレームを標本化する。 */
function sampleFrames(
  source: ProteinRenderSource,
  run: BackboneRun,
  curve: THREE.CatmullRomCurve3,
  subdivisions: number,
): RibbonSample[] {
  const samples: RibbonSample[] = [];
  let previousTangent: THREE.Vector3 | null = null;
  let previousWidth: THREE.Vector3 | null = null;
  const segments = Math.max(1, (run.points.length - 1) * subdivisions);
  // 酸素方向を優先しつつ、前フレームからの輸送方向で符号と回転を安定させる。
  for (let step = 0; step <= segments; step++) {
    const residuePosition = step / subdivisions;
    const t = step / segments;
    const center = curve.getPoint(t);
    const tangent = normalizedOr(curve.getTangent(t), previousTangent ?? new THREE.Vector3(0, 0, 1));
    const localIndex = Math.min(run.points.length - 1, Math.floor(residuePosition));
    const nextIndex = Math.min(run.points.length - 1, localIndex + 1);
    const localT = residuePosition - localIndex;
    const oxygen = backboneO(source.backbone, run.startIndex + localIndex, center);
    oxygen.lerp(backboneO(source.backbone, run.startIndex + nextIndex, center), localT);
    const oxygenDirection = oxygen.sub(center).projectOnPlane(tangent);
    const transported = transportedDirection(previousTangent, previousWidth, tangent);
    let widthDirection = oxygenDirection.lengthSq() > 1e-8
      ? oxygenDirection.normalize()
      : transported ?? normalizedOr(
        (Math.abs(tangent.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0))
          .projectOnPlane(tangent),
        new THREE.Vector3(1, 0, 0),
      );
    if (transported) {
      if (widthDirection.dot(transported) < 0) widthDirection.negate();
      widthDirection.lerp(transported, 0.25).normalize();
    }
    const thicknessDirection = normalizedOr(tangent.clone().cross(widthDirection), new THREE.Vector3(0, 1, 0));
    const sourceIndex = Math.min(source.backbone.backboneCount - 1, Math.round(run.startIndex + residuePosition));
    const backboneA = run.startIndex + localIndex;
    const backboneB = run.startIndex + nextIndex;
    samples.push({
      center,
      tangent,
      widthDirection,
      thicknessDirection,
      sourceIndex,
      residuePosition,
      residueA: source.motion.bindings.backboneResidues[backboneA] ?? backboneA,
      residueB: source.motion.bindings.backboneResidues[backboneB] ?? backboneB,
      residueT: localT,
    });
    previousTangent = tangent;
    previousWidth = widthDirection;
  }
  return samples;
}

/** βストランド末端2 residue の矢印幅を返す。 */
function sheetArrowFactor(residuePosition: number, end: number): number {
  const start = Math.max(0, end - 2);
  if (residuePosition < start) return 1;
  const progress = Math.min(1, Math.max(0, (residuePosition - start) / Math.max(1, end - start)));
  if (progress >= 1) return 0.04;
  return 1 + Math.sin(progress * Math.PI);
}

/** 二次構造に対応する断面上の一点を PDB 座標で返す。 */
function sectionPoint(
  sample: RibbonSample,
  kind: ProteinSecondaryKind,
  angle: number,
  sheetEnd: number,
): THREE.Vector3 {
  const arrowFactor = kind === 'sheet' ? sheetArrowFactor(sample.residuePosition, sheetEnd) : 1;
  const halfWidth = (kind === 'helix' ? 2 : 2 * arrowFactor) / 2;
  const halfThickness = PUBLICATION_THICKNESS / 2;
  // Coil と helix は12角形で円・楕円を近似し、sheet は矩形周上を4頂点で表す。
  if (kind === 'coil') {
    return sample.center.clone()
      .addScaledVector(sample.widthDirection, Math.cos(angle) * halfThickness)
      .addScaledVector(sample.thicknessDirection, Math.sin(angle) * halfThickness);
  }
  if (kind === 'helix') {
    return sample.center.clone()
      .addScaledVector(sample.widthDirection, Math.cos(angle) * halfWidth)
      .addScaledVector(sample.thicknessDirection, Math.sin(angle) * halfThickness);
  }
  const perimeter = (angle / (Math.PI * 2)) * 4;
  const side = Math.floor(perimeter);
  const progress = perimeter - side;
  const halfDepth = halfThickness;
  const corners: readonly (readonly [number, number])[] = [
    [halfWidth, halfDepth], [-halfWidth, halfDepth], [-halfWidth, -halfDepth], [halfWidth, -halfDepth],
  ];
  const first = corners[side % 4];
  const second = corners[(side + 1) % 4];
  if (!first || !second) return sample.center.clone();
  return sample.center.clone()
    .addScaledVector(sample.widthDirection, (first[0] * (1 - progress) + second[0] * progress))
    .addScaledVector(sample.thicknessDirection, (first[1] * (1 - progress) + second[1] * progress));
}

/** 二次構造に対応する断面頂点数を返す。 */
function sectionVertices(kind: ProteinSecondaryKind): number {
  return kind === 'sheet' ? 4 : 12;
}

/** 標本化したフレームを連続した側面メッシュへ変換する。 */
function ribbonGeometry(
  source: ProteinRenderSource,
  samples: readonly RibbonSample[],
  kind: ProteinSecondaryKind,
  sheetEnd: number,
  mode: ProteinRibbonColorMode,
  fixedColor: THREE.Color | null,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const residueA: number[] = [];
  const residueB: number[] = [];
  const residueT: number[] = [];
  const sectionVertexCount = sectionVertices(kind);
  // 各断面へ同じ頂点順を使い、隣接 ring 間の対応を固定する。
  for (const sample of samples) {
    for (let vertex = 0; vertex < sectionVertexCount; vertex++) {
      const point = sectionPoint(sample, kind, vertex * Math.PI * 2 / sectionVertexCount, sheetEnd);
      positions.push(point.x, point.y, point.z);
      const color = fixedColor ?? proteinRibbonColor(source, sample.sourceIndex, mode);
      colors.push(color.r, color.g, color.b);
      residueA.push(sample.residueA);
      residueB.push(sample.residueB);
      residueT.push(sample.residueT);
    }
  }
  const indices: number[] = [];
  for (let ring = 0; ring + 1 < samples.length; ring++) {
    for (let vertex = 0; vertex < sectionVertexCount; vertex++) {
      const next = (vertex + 1) % sectionVertexCount;
      const currentOffset = ring * sectionVertexCount;
      const nextOffset = (ring + 1) * sectionVertexCount;
      indices.push(currentOffset + vertex, nextOffset + vertex, currentOffset + next);
      indices.push(currentOffset + next, nextOffset + vertex, nextOffset + next);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  attachProteinResidueBinding(geometry, residueA, residueB, residueT);
  geometry.computeVertexNormals();
  geometry.userData.proteinSecondary = kind;
  geometry.userData.proteinSecondaryKind = kind;
  return geometry;
}

/** 異なる頂点数の二断面を正の長さを持つ側面で接続する。 */
function transitionGeometry(
  source: ProteinRenderSource,
  from: { readonly sample: RibbonSample; readonly kind: ProteinSecondaryKind; readonly sheetEnd: number },
  to: { readonly sample: RibbonSample; readonly kind: ProteinSecondaryKind; readonly sheetEnd: number },
  mode: ProteinRibbonColorMode,
  fixedColor: THREE.Color | null,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const residueA: number[] = [];
  const residueB: number[] = [];
  const residueT: number[] = [];
  const fromCount = sectionVertices(from.kind);
  const toCount = sectionVertices(to.kind);
  // 両端の閉じた断面を同じ周回方向で列挙する。
  for (const endpoint of [from, to]) {
    const count = sectionVertices(endpoint.kind);
    const color = fixedColor ?? proteinRibbonColor(source, endpoint.sample.sourceIndex, mode);
    for (let vertex = 0; vertex < count; vertex++) {
      const point = sectionPoint(
        endpoint.sample, endpoint.kind, vertex * Math.PI * 2 / count, endpoint.sheetEnd,
      );
      positions.push(point.x, point.y, point.z);
      colors.push(color.r, color.g, color.b);
      residueA.push(endpoint.sample.residueA);
      residueB.push(endpoint.sample.residueB);
      residueT.push(endpoint.sample.residueT);
    }
  }

  const indices: number[] = [];
  let fromVertex = 0;
  let toVertex = 0;
  // 周長の進捗が小さい側を進める zipper triangulation で両 ring の全辺を一度ずつ使う。
  while (fromVertex < fromCount || toVertex < toCount) {
    const nextFrom = (fromVertex + 1) / fromCount;
    const nextTo = (toVertex + 1) / toCount;
    const a = fromVertex % fromCount;
    const b = fromCount + (toVertex % toCount);
    if (Math.abs(nextFrom - nextTo) <= 1e-9) {
      const nextA = (fromVertex + 1) % fromCount;
      const nextB = fromCount + ((toVertex + 1) % toCount);
      indices.push(a, b, nextA, nextA, b, nextB);
      fromVertex++;
      toVertex++;
    } else if (nextFrom < nextTo) {
      indices.push(a, b, (fromVertex + 1) % fromCount);
      fromVertex++;
    } else {
      indices.push(a, b, fromCount + ((toVertex + 1) % toCount));
      toVertex++;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  attachProteinResidueBinding(geometry, residueA, residueB, residueT);
  geometry.computeVertexNormals();
  geometry.userData.proteinSecondary = to.kind;
  geometry.userData.proteinSecondaryKind = to.kind;
  geometry.userData.proteinRibbonTransition = true;
  geometry.userData.proteinTransitionFromKind = from.kind;
  geometry.userData.proteinTransitionToKind = to.kind;
  geometry.userData.proteinTransitionFromVertices = fromCount;
  geometry.userData.proteinTransitionToVertices = toCount;
  return geometry;
}

/** 論文図向けの非金属 Ribbon 材質を返す。 */
function ribbonMaterial(motion?: ProteinMotionBinding): THREE.MeshStandardNodeMaterial {
  return proteinStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.68,
    metalness: 0,
    side: THREE.DoubleSide,
  }, motion);
}

/** geometry をタンパク質用タグ付き Mesh として group へ追加する。 */
function addRibbonMesh(
  group: THREE.Group,
  geometry: THREE.BufferGeometry,
  source: ProteinRenderSource,
  startIndex: number,
  kind: ProteinSecondaryKind,
  motion?: ProteinMotionBinding,
): void {
  // 表示更新と component 運動が読む共通タグを各区間へ付ける。
  const mesh = new THREE.Mesh(geometry, ribbonMaterial(motion));
  mesh.userData.proteinComponent = source.backbone.backboneChains[startIndex] ?? 'A';
  mesh.userData.proteinRibbon = true;
  mesh.userData.proteinSecondary = kind;
  mesh.userData.proteinSecondaryKind = kind;
  if (geometry.userData.proteinRibbonTransition === true) {
    mesh.userData.proteinRibbonTransition = true;
    mesh.userData.proteinTransitionFromKind = geometry.userData.proteinTransitionFromKind;
    mesh.userData.proteinTransitionToKind = geometry.userData.proteinTransitionToKind;
    mesh.userData.proteinTransitionFromVertices = geometry.userData.proteinTransitionFromVertices;
    mesh.userData.proteinTransitionToVertices = geometry.userData.proteinTransitionToVertices;
  }
  mesh.userData.ownsGeometry = true;
  mesh.userData.ownsMaterial = true;
  group.add(mesh);
}

/** 論文図向けの断面と連続フレームで全主鎖を構築する。 */
function buildPublicationRibbon(
  source: ProteinRenderSource,
  mode: ProteinRibbonColorMode,
  fixedColor: THREE.Color | null,
  motion?: ProteinMotionBinding,
): THREE.Group {
  const group = new THREE.Group();
  // フレームは鎖全体で共有し、二次構造境界では断面だけを切り替える。
  for (const run of backboneRuns(source.backbone)) {
    if (run.points.length < 2) continue;
    const curve = new THREE.CatmullRomCurve3(run.points, false, 'centripetal', 0.35);
    const frames = sampleFrames(source, run, curve, RIBBON_SUBDIVISIONS);
    const spans = secondarySpans(source.backbone, run);
    for (let spanIndex = 0; spanIndex < spans.length; spanIndex++) {
      const span = spans[spanIndex];
      if (!span) continue;
      const first = span.start * RIBBON_SUBDIVISIONS;
      const last = span.end * RIBBON_SUBDIVISIONS;
      const previousSpan = spans[spanIndex - 1];
      if (previousSpan && last > first) {
        addRibbonMesh(group, transitionGeometry(
          source,
          { sample: frames[first]!, kind: previousSpan.kind, sheetEnd: previousSpan.end },
          { sample: frames[first + 1]!, kind: span.kind, sheetEnd: span.end },
          mode,
          fixedColor,
        ), source, run.startIndex + span.start, span.kind, motion);
      }
      const meshFirst = previousSpan ? first + 1 : first;
      const boundarySamples = frames.slice(meshFirst, last + 1);
      if (boundarySamples.length < 2) continue;
      addRibbonMesh(group, ribbonGeometry(
        source, boundarySamples, span.kind, span.end, mode, fixedColor,
      ), source, run.startIndex + span.start, span.kind, motion);
    }
  }
  return group;
}

/** 論文図に近い Ribbon 表示をローカル座標で生成する。 */
export function buildProteinRibbon(
  source: ProteinRenderSource, mode: ProteinRibbonColorMode, fixedColor: THREE.Color | null = null,
  motion?: ProteinMotionBinding,
): THREE.Group {
  return buildPublicationRibbon(source, mode, fixedColor, motion);
}

export { buildProteinCollisionRibbon } from './protein-collision-ribbon';
