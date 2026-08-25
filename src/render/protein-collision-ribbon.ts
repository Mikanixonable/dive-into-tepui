// 表示設定から独立した固定形状のタンパク質衝突リボンを生成する。
import * as THREE from 'three/webgpu';
import type { ProteinRibbonColorMode } from '../game/protein/protein-display';
import { proteinRibbonColor, proteinSecondaryKind, type ProteinSecondaryKind } from './protein-ribbon-color';
import type { ProteinBackboneAsset, ProteinRenderSource } from './protein-ribbon';

const RIBBON_SUBDIVISIONS = 12;
const RIBBON_THICKNESS = 0.32;

interface CollisionRun {
  readonly kind: ProteinSecondaryKind;
  readonly points: THREE.Vector3[];
  readonly startIndex: number;
}

/** 主鎖を鎖・欠損・二次構造境界で固定衝突区間へ分ける。 */
function collisionRuns(backbone: ProteinBackboneAsset): CollisionRun[] {
  const runs: CollisionRun[] = [];
  let current: CollisionRun | null = null;
  // 表示断面の変更から影響を受けないよう二次構造境界も区間境界にする。
  for (let index = 0; index < backbone.backboneCount; index++) {
    const offset = index * 3;
    const point = new THREE.Vector3(
      backbone.backboneCoordinates[offset]!,
      backbone.backboneCoordinates[offset + 1]!,
      backbone.backboneCoordinates[offset + 2]!,
    );
    const kind = proteinSecondaryKind(backbone.backboneSecondary[index]);
    const previous = current?.points[current.points.length - 1];
    const split = !current || !previous || point.distanceTo(previous) > 8
      || backbone.backboneChains[index] !== backbone.backboneChains[index - 1]
      || current.kind !== kind;
    if (split) {
      const nextRun: CollisionRun = { kind, points: [], startIndex: index };
      current = nextRun;
      runs.push(nextRun);
    }
    if (current) current.points.push(point);
  }
  return runs;
}

/** 指定 residue のカルボニル酸素座標を取得する。 */
function backboneO(backbone: ProteinBackboneAsset, index: number, fallback: THREE.Vector3): THREE.Vector3 {
  const coordinates = backbone.backboneOCoordinates;
  const offset = index * 3;
  if (!coordinates || offset + 2 >= coordinates.length) return fallback.clone();
  return new THREE.Vector3(coordinates[offset]!, coordinates[offset + 1]!, coordinates[offset + 2]!);
}

/** 衝突用ヘリックスの中心と主軸を主成分方向から求める。 */
function helixFrame(points: readonly THREE.Vector3[]): { center: THREE.Vector3; axis: THREE.Vector3 } {
  const center = points.reduce((sum, point) => sum.add(point), new THREE.Vector3()).multiplyScalar(1 / points.length);
  let axis = points[points.length - 1]!.clone().sub(points[0]!).normalize();
  if (axis.lengthSq() < 1e-8) axis.set(0, 0, 1);
  // 共分散行列を展開せず、べき乗法で最大分散方向へ収束させる。
  for (let iteration = 0; iteration < 8; iteration++) {
    const next = new THREE.Vector3();
    for (const point of points) {
      const offset = point.clone().sub(center);
      next.addScaledVector(offset, offset.dot(axis));
    }
    if (next.lengthSq() < 1e-8) break;
    axis.copy(next.normalize());
  }
  if (axis.dot(points[points.length - 1]!.clone().sub(points[0]!)) < 0) axis.negate();
  return { center, axis };
}

/** 固定衝突プロファイルの helix／sheet 側面と端面を生成する。 */
function collisionRibbonGeometry(
  source: ProteinRenderSource,
  run: CollisionRun,
  mode: ProteinRibbonColorMode,
  fixedColor: THREE.Color | null,
): THREE.BufferGeometry {
  const { backbone } = source;
  const positions: number[] = [];
  const colors: number[] = [];
  const curve = new THREE.CatmullRomCurve3([...run.points], false, 'centripetal', 0.35);
  const segments = Math.max(1, (run.points.length - 1) * RIBBON_SUBDIVISIONS);
  const frame = run.kind === 'helix' ? helixFrame(run.points) : null;
  let previousTangent: THREE.Vector3 | null = null;
  let previousWidthDirection: THREE.Vector3 | null = null;

  // 固定プロファイル固有の断面方向と末端形状を標本化する。
  for (let sample = 0; sample <= segments; sample++) {
    const t = sample / segments;
    const center = curve.getPoint(t);
    const tangent = curve.getTangent(t).normalize();
    const residuePosition = t * (run.points.length - 1);
    const localIndex = Math.min(run.points.length - 1, Math.floor(residuePosition));
    const nextIndex = Math.min(run.points.length - 1, localIndex + 1);
    const localT = residuePosition - localIndex;
    const sourceIndex = Math.min(backbone.backboneCount - 1, Math.round(run.startIndex + residuePosition));
    const oxygen = backboneO(backbone, run.startIndex + localIndex, center);
    if (nextIndex !== localIndex) oxygen.lerp(backboneO(backbone, run.startIndex + nextIndex, center), localT);

    let candidateWidthDirection: THREE.Vector3;
    if (frame !== null) {
      const radial = center.clone().sub(frame.center).projectOnPlane(frame.axis).normalize();
      candidateWidthDirection = frame.axis.clone().cross(radial).projectOnPlane(tangent).normalize();
    } else {
      candidateWidthDirection = oxygen.sub(center).projectOnPlane(tangent).normalize();
    }
    const widthDirection = candidateWidthDirection.clone();
    if (widthDirection.lengthSq() < 1e-8) {
      const reference = Math.abs(tangent.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      widthDirection.copy(reference).projectOnPlane(tangent).normalize();
    }
    if (previousTangent !== null && previousWidthDirection !== null) {
      const transport = previousWidthDirection.clone()
        .applyQuaternion(new THREE.Quaternion().setFromUnitVectors(previousTangent, tangent))
        .projectOnPlane(tangent).normalize();
      if (candidateWidthDirection.lengthSq() >= 1e-8 && candidateWidthDirection.dot(transport) < 0) {
        widthDirection.negate();
      }
      widthDirection.lerp(transport, 0.25).normalize();
    }
    previousTangent = tangent.clone();
    previousWidthDirection = widthDirection.clone();

    const thicknessDirection = tangent.clone().cross(widthDirection).normalize();
    const arrowFactor = run.kind === 'sheet' && residuePosition >= run.points.length - 2
      ? Math.max(0.04, 1.15 * (run.points.length - 1 - residuePosition)) : 1;
    const halfWidth = ((run.kind === 'helix' ? 2.0 : 1.8) * arrowFactor) / 2;
    const halfThickness = (RIBBON_THICKNESS * Math.min(1, arrowFactor)) / 2;
    for (const [widthSign, thicknessSign] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
      const corner = center.clone()
        .addScaledVector(widthDirection, halfWidth * widthSign!)
        .addScaledVector(thicknessDirection, halfThickness * thicknessSign!);
      positions.push(corner.x, corner.y, corner.z);
      const color = fixedColor ?? proteinRibbonColor(source, sourceIndex, mode);
      colors.push(color.r, color.g, color.b);
    }
  }

  const indices: number[] = [];
  for (let index = 0; index < segments; index++) {
    const a = index * 4;
    const b = a + 4;
    indices.push(a, b, a + 1, a + 1, b, b + 1);
    indices.push(a + 3, a + 2, b + 3, a + 2, b + 2, b + 3);
    indices.push(a, a + 3, b, a + 3, b + 3, b);
    indices.push(a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
  }
  indices.push(0, 1, 2, 0, 2, 3);
  const end = segments * 4;
  indices.push(end, end + 2, end + 1, end, end + 3, end + 2);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.userData.proteinSecondary = run.kind;
  geometry.userData.proteinSecondaryKind = run.kind;
  return geometry;
}

/** 固定衝突プロファイルの TubeGeometry へ頂点色を設定する。 */
function collisionTubeColors(
  source: ProteinRenderSource, geometry: THREE.BufferGeometry, startIndex: number,
  pointCount: number, tubularSegments: number, mode: ProteinRibbonColorMode, fixedColor: THREE.Color | null,
): void {
  const radialSegments = 12;
  const colors: number[] = [];
  // TubeGeometry の ring 番号を主鎖上の residue index へ戻して着色する。
  for (let vertex = 0; vertex < geometry.getAttribute('position').count; vertex++) {
    const longitudinal = Math.floor(vertex / (radialSegments + 1));
    const index = Math.min(source.backbone.backboneCount - 1,
      Math.round(startIndex + (pointCount - 1) * longitudinal / tubularSegments));
    const color = fixedColor ?? proteinRibbonColor(source, index, mode);
    colors.push(color.r, color.g, color.b);
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
}

// 頂点色だけで見た目が決まる固定マテリアルで、呼び出し元やタンパク質ごとに変わらないため
// モジュール全体で1つを使い回す。破棄しないので所有権(ownsMaterial)は与えない。
let sharedCollisionMaterial: THREE.MeshStandardMaterial | null = null;

function collisionMaterial(): THREE.MeshStandardMaterial {
  if (!sharedCollisionMaterial) {
    sharedCollisionMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.42, metalness: 0.24, side: THREE.DoubleSide,
    });
  }
  return sharedCollisionMaterial;
}

/** 固定衝突 geometry をタンパク質用タグ付き Mesh として追加する。 */
function addCollisionMesh(
  group: THREE.Group,
  geometry: THREE.BufferGeometry,
  source: ProteinRenderSource,
  run: CollisionRun,
): void {
  // 衝突形状の走査契約に必要な所有権・構造・component タグをまとめて付ける。
  const mesh = new THREE.Mesh(geometry, collisionMaterial());
  mesh.userData.proteinComponent = source.backbone.backboneChains[run.startIndex] ?? 'A';
  mesh.userData.proteinRibbon = true;
  mesh.userData.proteinSecondary = run.kind;
  mesh.userData.proteinSecondaryKind = run.kind;
  mesh.userData.proteinShadowReceiver = true;
  mesh.userData.ownsGeometry = true;
  mesh.userData.ownsMaterial = false;
  group.add(mesh);
}

/** 衝突判定用に固定した Ribbon 形状をローカル座標で生成する。 */
export function buildProteinCollisionRibbon(
  source: ProteinRenderSource,
  mode: ProteinRibbonColorMode,
  fixedColor: THREE.Color | null = null,
): THREE.Group {
  const group = new THREE.Group();
  // 二次構造ごとに専用断面を選び、衝突用タグを付与する。
  for (const run of collisionRuns(source.backbone)) {
    if (run.points.length < 2) continue;
    let geometry: THREE.BufferGeometry;
    if (run.kind === 'helix' || run.kind === 'sheet') {
      geometry = collisionRibbonGeometry(source, run, mode, fixedColor);
    } else {
      const curve = new THREE.CatmullRomCurve3(run.points, false, 'centripetal', 0.35);
      const tubularSegments = Math.max(2, (run.points.length - 1) * RIBBON_SUBDIVISIONS);
      geometry = new THREE.TubeGeometry(curve, tubularSegments, 0.38, 12, false);
      collisionTubeColors(source, geometry, run.startIndex, run.points.length, tubularSegments, mode, fixedColor);
      geometry.userData.proteinSecondary = run.kind;
      geometry.userData.proteinSecondaryKind = run.kind;
    }
    addCollisionMesh(group, geometry, source, run);
  }
  group.scale.setScalar(source.semantic.coordinateScale);
  return group;
}
