// プリミティブ組み合わせによるローポリ機体・弾・薬莢・デブリのメッシュ生成。
// 機体の機首は +Z 方向。
// ジオメトリ/マテリアルの構築自体は tools/export-models.mjs に移し、
// src/assets/models/*.json として事前に焼き出したものを ObjectLoader で読み込む。
import * as THREE from 'three/webgpu';
import * as C from '../game/const';
import type { Pdb5i4rColorMode } from '../game/game-entity/enemy';
import { isProteinDisplaySettings, type ProteinDisplaySettings, type ProteinRibbonColorMode } from '../game/protein/protein-display';
import { PDB5I4R_DISPLAY_ASSET } from '../game/protein/protein-display-asset';
import { mulberry32 } from '../physics/random';
import { markLitOpaque } from './pipeline/lit-layer';

// BufferGeometry を属性・index ごと複製する(clone() だけでは頂点属性配列を共有したままになる)。
function deepCloneGeometry(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const clone = geo.clone();
  for (const key in clone.attributes) {
    const attr = clone.attributes[key];
    if (attr) clone.attributes[key] = attr.clone();
  }
  if (clone.index) {
    clone.index = clone.index.clone();
  }
  return clone;
}

import playerData from '../assets/models/player.json';
import enemyData from '../assets/models/enemy.json';
import stage0EnemyDataA from '../assets/models/stage0EnemyA.json';
import stage0EnemyDataB from '../assets/models/stage0EnemyB.json';
import stage0EnemyDataC from '../assets/models/stage0EnemyC.json';
import pdb5i4rBackboneData from '../assets/models/pdb5i4rBackbone.json';
import magazineData from '../assets/models/magazine.json';
import ammoPickupData from '../assets/models/ammo.json';
import bulletData from '../assets/models/bullet.json';
import plasmaData from '../assets/models/plasma.json';
import casingData from '../assets/models/casing.json';
import debrisChunkData from '../assets/models/debrisChunk.json';
import debrisPanelData from '../assets/models/debrisPanel.json';
import debrisRodData from '../assets/models/debrisRod.json';

// 機関砲の銃口位置(機体座標系、前面に縦に並んだ 2 つの大きな短い穴)。
// 発砲・マズルフラッシュ・薬莢排出はこの 2 点から交互に行う。
export const MUZZLE_OFFSETS: { x: number; y: number; z: number }[] = [
  { x: 0, y: 0.55, z: 2.55 },
  { x: 0, y: -0.55, z: 2.55 },
];

// ラジエーターのヒンジ Group 名(機体座標系)。getObjectByName() で引く。
export const RADIATOR_OBJECT_NAMES = { up: 'radiatorUp', down: 'radiatorDown' } as const;

// 蛇腹1折りの一辺 [m]。tools/export-models.mjs と一致させる。
export const RADIATOR_SEGMENT_LENGTH = (2.3 * 4) / 6;

// 全開時、各折りが展開軸から残す傾き。0 だと折り目の判別が数値的に不安定になるため、
// 蛇腹の折り畳みが解消された1枚の板とみなせるごく小さい値を残す。
export const RADIATOR_DEPLOY_TILT = 15 * Math.PI / 180;

// ラジエーター折り目 Group 名(ヒンジ Group の子孫として入れ子)。
// tools/export-models.mjs の命名(`${radiatorUp/Down}Fold${i}`)と一致させる。
export function radiatorFoldName(side: 'up' | 'down', fold: number): string {
  return `${RADIATOR_OBJECT_NAMES[side]}Fold${fold}`;
}

export { RADIATOR_HINGE } from './radiator-hinge';

// マガジン寸法(機体座標系)。ベルト連結間隔(MAG_BELT_PITCH)は game.ts が
// マガジンリンクの並びを計算するのに使う。純粋な数値なので JSON 化はしない。
export const MAG_THICKNESS = 1.0;
export const MAG_WIDTH = MAG_THICKNESS * 4 * (2 / 3); // ベルト方向(X)
export const MAG_BELT_PITCH = MAG_WIDTH + 0.18; // 連結間隔

// ベルトが機体へ入っていく給弾口の位置(機体座標系 X)。ベルトの節点は継手(マガジンの端面)
// を表すので、これは先頭マガジンの機体側の端面 ——「マガジンが機体に飲み込まれる点」—— にあたる。
export const MAG_BELT_ANCHOR_X = -1.19;

const loader = new THREE.ObjectLoader();

// クローン時、THREE の Object3D.clone(true) は同じ parse から得た
// マテリアル/ジオメトリを参照共有する。呼び出し側が個体ごとに
// material の色や opacity を書き換える(マズルフラッシュ等)場合があるため、
// そうした用途のテンプレートは clone のたびに traverse してマテリアルを
// 複製し直す。ここで扱うテンプレート自体は opacity 等を実行時に書き換えない
// ものばかりだが、将来の変更に備えて一律で安全側(非共有)にしておく。
export function cloneIndependent<T extends THREE.Object3D>(template: T): T {
  const clone = template.clone(true) as T;
  // 各メッシュのマテリアルを独立に複製する
  clone.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && mesh.material) {
      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material.map((m) => m.clone());
      } else {
        mesh.material = mesh.material.clone();
      }
      mesh.userData.ownsMaterial = true;
    }
  });
  markLitOpaque(clone);
  return clone;
}

// data を初回だけパースしてキャッシュし、以後は cloneIndependent で複製を返すビルダーを作る。
function memoParse<T extends THREE.Object3D>(data: object): () => T {
  let cached: T | null = null;
  return () => {
    if (!cached) cached = loader.parse(data) as T;
    return cloneIndependent(cached);
  };
}

// 弾(bullet/plasma)専用: 大量発射されるため、geometry/material をクローンせず
// Object3D 階層だけ複製して共有する(THREE の Object3D.clone(true) は既定で
// geometry/material を参照共有するので、cloneIndependent と違い追加の
// .clone() は行わない)。弾本体のマテリアルは発射後に書き換えられないので
// 個体ごとの独立コピーは不要 — これにより毎発の生成で新規 GPU リソースが
// 増え続けるリークを防ぐ。
function memoParseShared<T extends THREE.Object3D>(data: object): () => T {
  let cached: T | null = null;
  return () => {
    if (!cached) cached = loader.parse(data) as T;
    return cached.clone(true) as T;
  };
}

const parsePlayer = memoParse<THREE.Group>(playerData);
const parseEnemy = memoParse<THREE.Group>(enemyData);
const parseStage0EnemyA = memoParse<THREE.Group>(stage0EnemyDataA);
const parseStage0EnemyB = memoParse<THREE.Group>(stage0EnemyDataB);
const parseStage0EnemyC = memoParse<THREE.Group>(stage0EnemyDataC);
const parseMagazine = memoParse<THREE.Group>(magazineData);
const parseAmmoPickup = memoParse<THREE.Group>(ammoPickupData);
const parseBullet = memoParseShared<THREE.Mesh>(bulletData);
const parsePlasma = memoParseShared<THREE.Mesh>(plasmaData);
const parseCasing = memoParse<THREE.Mesh>(casingData);
const parseDebrisChunk = memoParse<THREE.Mesh>(debrisChunkData);
const parseDebrisPanel = memoParse<THREE.Mesh>(debrisPanelData);
const parseDebrisRod = memoParse<THREE.Mesh>(debrisRodData);

// 薬莢は大量に生成されるため、排莢個体ごとの geometry/material は作らない。
// geometry はテンプレートを一度だけ deep clone して全長補正を焼き込み、material は
// parseCasing() がテンプレートから一度だけ複製したものを不変リソースとして共有する。
let casingGeometry: THREE.BufferGeometry | null = null;
let casingMaterial: THREE.MeshStandardMaterial | null = null;

function initCasingResources(): void {
  if (casingGeometry && casingMaterial) return;

  const template = parseCasing();
  casingGeometry = deepCloneGeometry(template.geometry);
  casingGeometry.scale(1, 2, 1);
  casingMaterial = template.material as THREE.MeshStandardMaterial;
  casingMaterial.color.setHex(0xFF9F5E);
  casingMaterial.metalness = 0.8;
  casingMaterial.roughness = 0.3;
}

// 自機のメッシュを生成する。
export function buildPlayerShip(): THREE.Group {
  return parsePlayer();
}

// マガジンリンク1個分のメッシュを生成する。
export function buildMagazineMesh(): THREE.Group {
  return parseMagazine();
}

// 弾を抜いた「空」のマガジン(外枠のみ)。給弾機構内で既に発射済みの弾を
// 保持しているマガジンは見た目上「空」であるべきなので、ここで弾(role==='round'
// が付いた丸・弾頭メッシュ)を除去したフレームだけの版を作る。
// 右舷排出口の常設表示・排出デブリの両方で使う。
let magazineFrameTemplate: THREE.Group | null = null;

export function buildMagazineFrame(): THREE.Group {
  if (magazineFrameTemplate === null) {
    const g = parseMagazine();
    for (const child of [...g.children]) {
      if ((child as THREE.Mesh).userData?.['role'] === 'round') g.remove(child);
    }
    // 排出フレームは大量に作られるため、テンプレートの geometry/material を共有する。
    // DebrisPiece.dispose() が共有リソースを解放しないよう所有権を明示する。
    g.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.userData.ownsGeometry = false;
      mesh.userData.ownsMaterial = false;
    });
    magazineFrameTemplate = g;
  }
  return magazineFrameTemplate.clone(true) as THREE.Group;
}

// 軌道上の弾薬補給ピックアップ。マガジン数個を束ねてビーコンを付けた漂流物。
// テンプレートは既定の count=4 で焼き出し済み。count が既定と異なる場合は、
// マガジンサブメッシュを buildMagazineMesh() 経由で再利用しながら都度組み立てる。
let ammoPickupBeaconGeometry: THREE.OctahedronGeometry | null = null;
let ammoPickupBeaconMaterial: THREE.MeshBasicMaterial | null = null;

// 軌道上補給物のメッシュを生成する。count はマガジン本数(既定 4 はテンプレートを再利用)。
export function buildAmmoPickup(count = 4): THREE.Group {
  if (count === 4) return parseAmmoPickup();
  const g = new THREE.Group();
  // マガジンを count 本、縦一列に並べる
  for (let i = 0; i < count; i++) {
    const mag = buildMagazineMesh();
    mag.position.y = (i - (count - 1) / 2) * (MAG_THICKNESS + 0.12);
    g.add(mag);
  }
  if (!ammoPickupBeaconGeometry) ammoPickupBeaconGeometry = new THREE.OctahedronGeometry(0.35, 0);
  if (!ammoPickupBeaconMaterial) {
    ammoPickupBeaconMaterial = new THREE.MeshBasicMaterial({ color: 0x4de8ff });
  }

  // 先端にビーコンを追加する
  const beacon = withDispose(new THREE.Mesh(ammoPickupBeaconGeometry, ammoPickupBeaconMaterial.clone()), false, true);
  beacon.position.y = (count / 2) * (MAG_THICKNESS + 0.12) + 0.4;
  g.add(beacon);
  return g;
}

// 敵機: プレースホルダの基本色で焼き出されたテンプレートのうち、
// userData.role === 'accent' が付与されたマテリアルだけを accent 色へ塗り替える。
export function buildEnemyShip(accent: string | number = 0xff4a3d): THREE.Group {
  const g = parseEnemy();
  // accent ロールが付いたマテリアルだけ塗り替える
  g.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = mesh.material as THREE.Material & { color?: THREE.Color };
    if (mat && mat.userData && mat.userData.role === 'accent' && mat.color) {
      mat.color.set(accent);
    }
  });
  return g;
}

// PDB 5I4R のCα主鎖とHELIX/SHEET注釈から、論文・PDBビューアで一般的なcartoon表現を
// 組み立てる。HELIXは平たい帯状フィラメント、SHEETは矢印、COILは細いチューブで表す。
// 座標はÅのままの比率を保ち、ゲーム内のサイズへは一様スケールだけを掛ける。
const PDB5I4R_COORDINATE_SCALE = 0.06;
const PDB5I4R_RIBBON_SUBDIVISIONS = 12;
const PDB5I4R_RIBBON_THICKNESS = 0.32;

function pdb5i4rRainbowColor(t: number): THREE.Color {
  return new THREE.Color().setHSL(0.66 * (1 - Math.max(0, Math.min(1, t))), 0.86, 0.56);
}

const pdb5i4rBFactorMin = Math.min(...pdb5i4rBackboneData.backboneBFactors);
const pdb5i4rBFactorMax = Math.max(...pdb5i4rBackboneData.backboneBFactors);

function pdb5i4rRibbonColorAt(index: number, mode: ProteinRibbonColorMode): THREE.Color {
  if (mode === 'rainbow') {
    return pdb5i4rRainbowColor(index / Math.max(1, pdb5i4rBackboneData.backboneCount - 1));
  }
  if (mode === 'secondary-structure') {
    const kind = pdb5i4rBackboneData.backboneSecondary[index] ?? 'coil';
    if (kind === 'helix') return new THREE.Color(0xe85d75);
    if (kind === 'sheet') return new THREE.Color(0xf2c14e);
    return new THREE.Color(0x8fa7bd);
  }
  if (mode === 'component-role') {
    const entity = pdb5i4rBackboneData.backboneEntities[index]!;
    if (entity === 1) return new THREE.Color(0x4fc3f7); // CdiA
    if (entity === 4) return new THREE.Color(0xffc857); // CdiI
    return new THREE.Color(0xa78bfa); // EF-Tu
  }
  if (mode === 'b-factor') {
    const range = Math.max(1e-6, pdb5i4rBFactorMax - pdb5i4rBFactorMin);
    return pdb5i4rRainbowColor((pdb5i4rBackboneData.backboneBFactors[index]! - pdb5i4rBFactorMin) / range);
  }
  if (mode === 'entity') {
    const entity = pdb5i4rBackboneData.backboneEntities[index]!;
    return new THREE.Color().setHSL(((entity - 1) * 0.19 + 0.04) % 1, 0.78, 0.56);
  }
  const chain = pdb5i4rBackboneData.backboneChains[index] ?? '';
  const chainIndex = Math.max(0, chain.charCodeAt(0) - 65);
  return new THREE.Color().setHSL((chainIndex * 0.13 + 0.02) % 1, 0.78, 0.56);
}

// ヘリックスは実測Cα列の局所的な揺らぎではなく、残基列全体から求めた主軸を基準にする。
// これにより短いヘリックスでも帯の位相が跳ねず、円に近い螺旋を保てる。
function pdb5i4rHelixFrame(points: readonly THREE.Vector3[]): { center: THREE.Vector3; axis: THREE.Vector3 } {
  const center = points.reduce((sum, point) => sum.add(point), new THREE.Vector3()).multiplyScalar(1 / points.length);
  let axis = points[points.length - 1]!.clone().sub(points[0]!).normalize();
  if (axis.lengthSq() < 1e-8) axis.set(0, 0, 1);
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

function pdb5i4rRibbonGeometry(
  points: readonly THREE.Vector3[], width: number, startIndex: number, colorMode: ProteinRibbonColorMode,
  arrow: boolean, helixFrame: { center: THREE.Vector3; axis: THREE.Vector3 } | null,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const curve = new THREE.CatmullRomCurve3([...points], false, 'centripetal', 0.35);
  const segments = Math.max(1, (points.length - 1) * PDB5I4R_RIBBON_SUBDIVISIONS);
  let previousTangent: THREE.Vector3 | null = null;
  let previousWidthDirection: THREE.Vector3 | null = null;
  for (let sample = 0; sample <= segments; sample++) {
    const t = sample / segments;
    const center = curve.getPoint(t);
    const tangent = curve.getTangent(t).normalize();
    const residuePosition = t * (points.length - 1);
    const localIndex = Math.min(points.length - 1, Math.floor(residuePosition));
    const nextIndex = Math.min(points.length - 1, localIndex + 1);
    const localT = residuePosition - localIndex;
    const globalIndex = Math.min(
      pdb5i4rBackboneData.backboneCount - 1,
      Math.round(startIndex + residuePosition),
    );
    const oxygenOffset = (startIndex + localIndex) * 3;
    const oxygen = new THREE.Vector3(
      pdb5i4rBackboneData.backboneOCoordinates[oxygenOffset]!,
      pdb5i4rBackboneData.backboneOCoordinates[oxygenOffset + 1]!,
      pdb5i4rBackboneData.backboneOCoordinates[oxygenOffset + 2]!,
    );
    if (nextIndex !== localIndex) {
      const nextOffset = (startIndex + nextIndex) * 3;
      oxygen.lerp(new THREE.Vector3(
        pdb5i4rBackboneData.backboneOCoordinates[nextOffset]!,
        pdb5i4rBackboneData.backboneOCoordinates[nextOffset + 1]!,
        pdb5i4rBackboneData.backboneOCoordinates[nextOffset + 2]!,
      ), localT);
    }
    const candidateWidthDirection = helixFrame === null
      ? oxygen.sub(center).projectOnPlane(tangent).normalize()
      : (() => {
        // HELIXは軸から外へ広がる階段状の帯ではなく、円筒へ巻きつくwrap型の帯にする。
        // 半径方向と軸の外積が螺旋の周方向なので、ここをリボンの幅方向に使う。
        const radial = center.clone().sub(helixFrame.center).projectOnPlane(helixFrame.axis).normalize();
        return helixFrame.axis.clone().cross(radial).projectOnPlane(tangent).normalize();
      })();
    const widthDirection = candidateWidthDirection.clone();
    if (widthDirection.lengthSq() < 1e-8) {
      const reference = Math.abs(tangent.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      widthDirection.copy(reference).projectOnPlane(tangent).normalize();
    }
    if (previousTangent !== null && previousWidthDirection !== null) {
      const transport = previousWidthDirection.clone()
        .applyQuaternion(new THREE.Quaternion().setFromUnitVectors(previousTangent, tangent))
        .projectOnPlane(tangent).normalize();
      if (candidateWidthDirection.lengthSq() >= 1e-8 && candidateWidthDirection.dot(transport) < 0) widthDirection.negate();
      widthDirection.lerp(transport, 0.25).normalize();
    }
    previousTangent = tangent.clone();
    previousWidthDirection = widthDirection.clone();
    const thicknessDirection = tangent.clone().cross(widthDirection).normalize();
    const arrowFactor = arrow && residuePosition >= points.length - 2
      ? Math.max(0.04, 1.15 * (points.length - 1 - residuePosition))
      : 1;
    const halfWidth = (width * arrowFactor) / 2;
    const halfThickness = (PDB5I4R_RIBBON_THICKNESS * Math.min(1, arrowFactor)) / 2;
    const corners = [
      center.clone().addScaledVector(widthDirection, halfWidth).addScaledVector(thicknessDirection, halfThickness),
      center.clone().addScaledVector(widthDirection, -halfWidth).addScaledVector(thicknessDirection, halfThickness),
      center.clone().addScaledVector(widthDirection, -halfWidth).addScaledVector(thicknessDirection, -halfThickness),
      center.clone().addScaledVector(widthDirection, halfWidth).addScaledVector(thicknessDirection, -halfThickness),
    ];
    for (const corner of corners) positions.push(corner.x, corner.y, corner.z);
    const color = pdb5i4rRibbonColorAt(globalIndex, colorMode);
    for (let corner = 0; corner < 4; corner++) colors.push(color.r, color.g, color.b);
  }
  const indices: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = i * 4;
    const b = a + 4;
    indices.push(a, b, a + 1, a + 1, b, b + 1); // 上面
    indices.push(a + 3, a + 2, b + 3, a + 2, b + 2, b + 3); // 下面
    indices.push(a, a + 3, b, a + 3, b + 3, b); // 左側面
    indices.push(a + 1, b + 1, a + 2, a + 2, b + 1, b + 2); // 右側面
  }
  indices.push(0, 1, 2, 0, 2, 3); // N端面
  const end = segments * 4;
  indices.push(end, end + 2, end + 1, end, end + 3, end + 2); // C端面
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function pdb5i4rBackboneRuns(): { kind: string; points: THREE.Vector3[]; startIndex: number }[] {
  const runs: { kind: string; points: THREE.Vector3[]; startIndex: number }[] = [];
  let current: { kind: string; points: THREE.Vector3[]; startIndex: number } | null = null;
  for (let i = 0; i < pdb5i4rBackboneData.backboneCount; i++) {
    const offset = i * 3;
    const point = new THREE.Vector3(
      pdb5i4rBackboneData.backboneCoordinates[offset]!,
      pdb5i4rBackboneData.backboneCoordinates[offset + 1]!,
      pdb5i4rBackboneData.backboneCoordinates[offset + 2]!,
    );
    const kind = pdb5i4rBackboneData.backboneSecondary[i]!;
    // The source is ordered by chain; a large coordinate jump also separates chains or missing residues.
    if (current === null || current.kind !== kind || (i > 0 &&
      Math.abs(point.distanceTo(current.points[current.points.length - 1]!)) > 8)) {
      current = { kind, points: [], startIndex: i };
      runs.push(current);
    }
    current.points.push(point);
  }
  return runs;
}

function pdb5i4rTubeColors(
  geometry: THREE.BufferGeometry, startIndex: number, pointCount: number, totalPoints: number,
  tubularSegments: number, colorMode: ProteinRibbonColorMode,
): void {
  const radialSegments = 12;
  const colors: number[] = [];
  for (let vertex = 0; vertex < geometry.getAttribute('position').count; vertex++) {
    const longitudinal = Math.floor(vertex / (radialSegments + 1));
    const index = Math.min(totalPoints - 1, Math.round(startIndex + (pointCount - 1) * longitudinal / tubularSegments));
    const color = pdb5i4rRibbonColorAt(index, colorMode);
    colors.push(color.r, color.g, color.b);
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
}

function normalizePdb5i4rDisplay(display: ProteinDisplaySettings | Pdb5i4rColorMode): ProteinDisplaySettings {
  if (typeof display !== 'string' && isProteinDisplaySettings(display)) return display;
  if (display === 'element') return { representation: 'molecular', colorMode: 'element' };
  if (display === 'surface-charge' || display === 'hydrophobicity') return { representation: 'silhouette', colorMode: display };
  if (display === 'rainbow' || display === 'secondary-structure' || display === 'component-role') {
    return { representation: 'ribbon', colorMode: display };
  }
  return { representation: 'ribbon', colorMode: 'chain' };
}

const PDB5I4R_ELEMENT_COLORS: Readonly<Record<string, number>> = {
  H: 0xffffff,
  C: 0x909090,
  N: 0x3050f8,
  O: 0xff0d0d,
  F: 0x90e050,
  P: 0xff8000,
  S: 0xffff30,
  CL: 0x1ff01f,
  BR: 0xa62929,
  I: 0x940094,
  SE: 0xffa100,
  MG: 0x8aff00,
  ZN: 0x7d80b0,
  NA: 0xab5cf2,
  CA: 0x3dff00,
  FE: 0xe06633,
  K: 0x8f40d4,
};

function molecularAtomMaterial(element: string): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: PDB5I4R_ELEMENT_COLORS[element.toUpperCase()] ?? 0xc0c0c0,
    roughness: 0.26,
    metalness: 0.18,
  });
}

function buildPdb5i4rMolecularShip(): THREE.Group {
  const group = new THREE.Group();
  const scale = PDB5I4R_COORDINATE_SCALE;
  const atomPositions = PDB5I4R_DISPLAY_ASSET.atoms.coordinates;
  const atomCount = PDB5I4R_DISPLAY_ASSET.atoms.count;
  const byComponent = new Map<string, Map<string, { count: number; radius: number }>>();
  for (let atom = 0; atom < atomCount; atom++) {
    const component = PDB5I4R_DISPLAY_ASSET.atoms.chainTable[PDB5I4R_DISPLAY_ASSET.atoms.chains[atom] ?? 0] ?? 'A';
    const element = PDB5I4R_DISPLAY_ASSET.atoms.elementTable[PDB5I4R_DISPLAY_ASSET.atoms.elements[atom] ?? 1] ?? 'C';
    const elements = byComponent.get(component) ?? new Map<string, { count: number; radius: number }>();
    const atomRadius = PDB5I4R_DISPLAY_ASSET.atoms.radiusTable[PDB5I4R_DISPLAY_ASSET.atoms.radiusCodes[atom] ?? 1] ?? 1.7;
    const entry = elements.get(element) ?? { count: 0, radius: atomRadius };
    entry.count += 1;
    elements.set(element, entry);
    byComponent.set(component, elements);
  }
  for (const [component, elementCounts] of byComponent) {
    const componentGroup = new THREE.Group();
    componentGroup.userData.proteinComponent = component;
    for (const [element, entry] of elementCounts) {
      const radius = Math.max(0.16, entry.radius);
      const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(radius, 8, 6), molecularAtomMaterial(element), entry.count);
      const matrix = new THREE.Matrix4();
      let instance = 0;
      for (let atom = 0; atom < atomCount; atom++) {
        const atomComponent = PDB5I4R_DISPLAY_ASSET.atoms.chainTable[PDB5I4R_DISPLAY_ASSET.atoms.chains[atom] ?? 0] ?? 'A';
        const atomElement = PDB5I4R_DISPLAY_ASSET.atoms.elementTable[PDB5I4R_DISPLAY_ASSET.atoms.elements[atom] ?? 1] ?? 'C';
        if (atomComponent !== component || atomElement !== element) continue;
        matrix.makeTranslation(atomPositions[atom * 3]!, atomPositions[atom * 3 + 1]!, atomPositions[atom * 3 + 2]!);
        mesh.setMatrixAt(instance++, matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.userData.ownsGeometry = true;
      mesh.userData.ownsMaterial = true;
      componentGroup.add(mesh);
    }
    group.add(componentGroup);
  }
  const bondPositions: number[] = [];
  const indices = PDB5I4R_DISPLAY_ASSET.bonds.pairs;
  for (let bond = 0; bond + 1 < indices.length; bond += 2) {
    const a = indices[bond]!;
    const b = indices[bond + 1]!;
    if (a < 0 || b < 0 || a >= atomCount || b >= atomCount) continue;
    bondPositions.push(
      atomPositions[a * 3]!, atomPositions[a * 3 + 1]!, atomPositions[a * 3 + 2]!,
      atomPositions[b * 3]!, atomPositions[b * 3 + 1]!, atomPositions[b * 3 + 2]!,
    );
  }
  const bondGeometry = new THREE.BufferGeometry();
  bondGeometry.setAttribute('position', new THREE.Float32BufferAttribute(bondPositions, 3));
  const bonds = new THREE.LineSegments(bondGeometry, new THREE.LineBasicMaterial({ color: 0x778899, transparent: true, opacity: 0.7 }));
  bonds.userData.proteinComponent = 'A';
  bonds.userData.ownsGeometry = true;
  bonds.userData.ownsMaterial = true;
  group.add(bonds);
  group.scale.setScalar(scale);
  return group;
}

function surfaceColor(value: number, mode: 'surface-charge' | 'hydrophobicity', min: number, max: number): THREE.Color {
  const t = Math.max(0, Math.min(1, (value - min) / Math.max(1e-6, max - min)));
  if (mode === 'surface-charge') {
    if (t < 0.5) return new THREE.Color(0xd84a4a).lerp(new THREE.Color(0xf4f0e8), t * 2);
    return new THREE.Color(0xf4f0e8).lerp(new THREE.Color(0x477fd1), (t - 0.5) * 2);
  }
  return new THREE.Color(0x4575b4).lerp(new THREE.Color(0xf7f7f7), t < 0.5 ? t * 2 : 1)
    .lerp(new THREE.Color(0xd95f02), t > 0.5 ? (t - 0.5) * 2 : 0);
}

function buildPdb5i4rSilhouetteShip(colorMode: 'surface-charge' | 'hydrophobicity'): THREE.Group {
  const group = new THREE.Group();
  const surface = PDB5I4R_DISPLAY_ASSET.surface.mesh;
  const values = colorMode === 'surface-charge' ? surface.charge : surface.hydrophobicity;
  // The offline asset stores both fields as signed int8-compatible values so the
  // JSON stays compact: -127..127 maps to charge -1..1 or Kyte-Doolittle -4.5..4.5.
  const min = -127;
  const max = 127;
  const components = new Set(surface.component.length > 0 ? surface.component : ['A']);
  for (const component of components) {
    const geometry = new THREE.BufferGeometry();
    const centeredAt = PDB5I4R_DISPLAY_ASSET.coordinateFrame.centeredAt;
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    const remap = new Map<number, number>();
    const appendVertex = (globalVertex: number): number => {
      const existing = remap.get(globalVertex);
      if (existing !== undefined) return existing;
      const localVertex = positions.length / 3;
      positions.push(
        surface.position[globalVertex * 3]! - (centeredAt[0] ?? 0),
        surface.position[globalVertex * 3 + 1]! - (centeredAt[1] ?? 0),
        surface.position[globalVertex * 3 + 2]! - (centeredAt[2] ?? 0),
      );
      const color = surfaceColor(values[globalVertex] ?? 0, colorMode, min, max);
      colors.push(color.r, color.g, color.b);
      remap.set(globalVertex, localVertex);
      return localVertex;
    };
    for (let offset = 0; offset + 2 < surface.index.length; offset += 3) {
      const a = surface.index[offset]!;
      const b = surface.index[offset + 1]!;
      const c = surface.index[offset + 2]!;
      if ((surface.component[a] ?? component) === component) indices.push(appendVertex(a), appendVertex(b), appendVertex(c));
    }
    if (indices.length === 0) continue;
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.24, metalness: 0.3, side: THREE.DoubleSide,
    }));
    mesh.userData.proteinComponent = component;
    mesh.userData.ownsGeometry = true;
    mesh.userData.ownsMaterial = true;
    group.add(mesh);
  }
  group.scale.setScalar(PDB5I4R_COORDINATE_SCALE);
  return group;
}

function buildPdb5i4rRibbonShip(colorMode: ProteinRibbonColorMode): THREE.Group {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.42,
    metalness: 0.28,
    side: THREE.DoubleSide,
    vertexColors: true,
  });
  material.userData.role = 'accent';
  const group = new THREE.Group();
  let ownsMaterial = true;
  for (const run of pdb5i4rBackboneRuns()) {
    if (run.points.length < 2) continue;
    let geometry: THREE.BufferGeometry;
    if (run.kind === 'helix' || run.kind === 'sheet') {
      geometry = pdb5i4rRibbonGeometry(
        run.points,
        run.kind === 'helix' ? 2.0 : 1.8,
        run.startIndex,
        colorMode,
        run.kind === 'sheet',
        run.kind === 'helix' ? pdb5i4rHelixFrame(run.points) : null,
      );
    } else {
      const radius = 0.38;
      const curve = new THREE.CatmullRomCurve3(run.points, false, 'centripetal', 0.35);
      const tubularSegments = Math.max(2, (run.points.length - 1) * PDB5I4R_RIBBON_SUBDIVISIONS);
      geometry = new THREE.TubeGeometry(curve, tubularSegments, radius, 12, false);
      pdb5i4rTubeColors(geometry, run.startIndex, run.points.length, pdb5i4rBackboneData.backboneCount, tubularSegments, colorMode);
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.proteinComponent = pdb5i4rBackboneData.backboneChains[run.startIndex] ?? 'A';
    mesh.userData.ownsGeometry = true;
    mesh.userData.ownsMaterial = ownsMaterial;
    ownsMaterial = false;
    group.add(mesh);
  }
  group.scale.setScalar(PDB5I4R_COORDINATE_SCALE);
  return group;
}

export function buildPdb5i4rEnemyShip(display: ProteinDisplaySettings | Pdb5i4rColorMode = { representation: 'ribbon', colorMode: 'chain' }): THREE.Group {
  const settings = normalizePdb5i4rDisplay(display);
  if (settings.representation === 'molecular') return buildPdb5i4rMolecularShip();
  if (settings.representation === 'silhouette') return buildPdb5i4rSilhouetteShip(settings.colorMode);
  return buildPdb5i4rRibbonShip(settings.colorMode);
}

// 既存の5I4R敵の表示メッシュだけを差し替え、位置・姿勢・スケール・戦闘用オーバーレイを維持する。
export function recolorPdb5i4rEnemyShip(target: THREE.Object3D, display: ProteinDisplaySettings | Pdb5i4rColorMode): void {
  const replacement = buildPdb5i4rEnemyShip(display);
  for (const child of [...target.children]) {
    child.traverse((nested) => {
      const mesh = nested as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.userData.ownsGeometry) mesh.geometry.dispose();
      if (mesh.userData.ownsMaterial) {
        if (Array.isArray(mesh.material)) mesh.material.forEach((material) => material.dispose());
        else mesh.material.dispose();
      }
    });
    target.remove(child);
  }
  for (const child of [...replacement.children]) target.add(child);
  replacement.clear();
}

// stage0 敵機のメッシュを typeIndex(0〜2)の機体テンプレートから生成し、accent 色に塗り替える。
export function buildStage0EnemyShip(accent: string | number = 0x3dc6ff, typeIndex = 0): THREE.Group {
  let g: THREE.Group;
  // typeIndex で機体テンプレートを選ぶ
  if (typeIndex === 1) g = parseStage0EnemyB();
  else if (typeIndex === 2) g = parseStage0EnemyC();
  else g = parseStage0EnemyA();

  // accent ロールが付いたマテリアルだけ塗り替える
  g.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = mesh.material as THREE.Material & { color?: THREE.Color };
    if (mat && mat.userData && mat.userData.role === 'accent' && mat.color) {
      mat.color.set(accent);
    }
  });
  return g;
}

// 弾のハロー(光芒)はモジュールスコープで 1 個だけ生成して全弾で共有する
// (毎発生成すると GPU リソースが撃つたびにリークする)。色・形状は固定なので
// 個体ごとの独立コピーは不要。
let bulletHaloGeom: THREE.CylinderGeometry | null = null;
let bulletHaloMat: THREE.MeshBasicMaterial | null = null;

// 自機弾のメッシュ(本体+ハロー)を生成する。ハロー用ジオメトリ/マテリアルは全弾で共有する。
export function buildBulletMesh(): THREE.Group {
  const m = parseBullet();

  // 敵のプラズマ弾と同様、自機の弾丸にも光芒(半透明の加算合成ハロー)を付ける
  if (!bulletHaloGeom) {
    bulletHaloGeom = new THREE.CylinderGeometry(0.5, 0.5, 7, 8);
    bulletHaloGeom.rotateX(Math.PI / 2); // 進行方向(Z軸)に合わせる
  }
  if (!bulletHaloMat) {
    bulletHaloMat = new THREE.MeshBasicMaterial({
      color: 0xffc86e,
      transparent: true,
      opacity: 0.35,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
  }
  const halo = new THREE.Mesh(bulletHaloGeom, bulletHaloMat);

  const g = new THREE.Group();
  g.add(m);
  g.add(halo);
  return g;
}

// InstancedPool が全弾で使い回す共有ジオメトリ/マテリアルを公開する(複製は作らない)。
export function bulletBodyResources(): { geometry: THREE.BufferGeometry; material: THREE.Material } {
  const m = parseBullet();
  return { geometry: m.geometry, material: m.material as THREE.Material };
}

export function bulletHaloResources(): { geometry: THREE.BufferGeometry; material: THREE.Material } {
  buildBulletMesh(); // ハロー用ジオメトリ/マテリアルを未生成なら生成する
  return { geometry: bulletHaloGeom!, material: bulletHaloMat! };
}

let plasmaGeomFixed = false;
let plasmaBodyMat: THREE.MeshBasicMaterial | null = null;

// 敵プラズマ弾のメッシュ(本体のみ)を生成する。マテリアルは1つキャッシュして全弾で共有する。
export function buildPlasmaMesh(): THREE.Mesh {
  const m = parsePlasma();
  if (!plasmaGeomFixed) {
    // plasma.json (CylinderGeometry) は toJSON() がコンストラクタ引数のみを保存する
    // 仕様のため、export-models.mjs 側で焼き込んだ rotateX() 補正がロード時に失われ、
    // 円柱の長さ軸が既定の Y のままになる。
    // memoParseShared は geometry を clone しないため
    // 全インスタンスがこの共有ジオメトリを参照する。一度だけ補正を掛け直す
    // (毎回だと累積回転してしまう)。
    m.geometry.rotateX(Math.PI / 2);
    plasmaGeomFixed = true;
  }
  if (!plasmaBodyMat) {
    plasmaBodyMat = new THREE.MeshBasicMaterial({
      color: C.COLOR_ENEMY_PLASMA,
      transparent: false,
      opacity: 1.0,
      depthWrite: true,
      blending: THREE.NormalBlending,
    });
  }
  m.material = plasmaBodyMat;

  // スケールを大きくして視認性を上げる
  m.scale.set(1.5, 1.5, 1.5);

  return m;
}

// InstancedPool が全プラズマ弾で使い回す共有ジオメトリ/マテリアルを公開する。
export function plasmaBodyResources(): { geometry: THREE.BufferGeometry; material: THREE.Material } {
  const m = buildPlasmaMesh();
  return { geometry: m.geometry, material: m.material as THREE.Material };
}

// 薬莢メッシュを生成する。全長を通常の2倍にした geometry と銅色 material は共有する。
export function buildCasingMesh(): THREE.Mesh {
  initCasingResources();
  const mesh = new THREE.Mesh(casingGeometry!, casingMaterial!);
  // DebrisPiece.dispose() が共有リソースを解放しないよう、所有権を明示する。
  mesh.userData.ownsGeometry = false;
  mesh.userData.ownsMaterial = false;
  return mesh;
}

// InstancedPool が全薬莢で使い回す共有ジオメトリ/マテリアルを公開する。
export function casingBodyResources(): { geometry: THREE.BufferGeometry; material: THREE.Material } {
  initCasingResources();
  return { geometry: casingGeometry!, material: casingMaterial! };
}

// 破片(fragment): 撃破時の飛散と被弾欠片に使う。InstancedPool で個体をまとめて描くため、
// 個体ごとに乱数でジオメトリを作ることはしない — 固定シードの乱数で起動時に一度だけ
// DEBRIS_FRAGMENT_VARIANT_COUNT 種類のジオメトリ(単位スケール)を焼き、色は
// InstancedPool の per-instance color で個体ごとに与える(debrisFragmentResources)。

// ジオメトリ・マテリアルの所有権をマークするヘルパー
function withDispose(mesh: THREE.Mesh, ownsGeom = true, ownsMat = true): THREE.Mesh {
  mesh.userData.ownsGeometry = ownsGeom;
  mesh.userData.ownsMaterial = ownsMat;
  return mesh;
}

// 頂点を index 順に写像して法線を再計算する(乱数を使う写像でも呼び出し順が保たれる)
function displaceVertices(geo: THREE.BufferGeometry, map: (x: number, y: number, z: number) => [number, number, number]): void {
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const [x, y, z] = map(pos.getX(i), pos.getY(i), pos.getZ(i));
    pos.setXYZ(i, x, y, z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

// 破片ジオメトリのバリアント本数。DebrisPiece がこの中から乱択して自分の形状とする。
export const DEBRIS_FRAGMENT_VARIANT_COUNT = 18;
// バリアント生成用の乱数シード(起動のたびに形が変わらないよう固定する)。
const DEBRIS_FRAGMENT_SEED = 0xdeb71;

// 破片ジオメトリを1つ、単位スケールで生成する。色は個体ごとに InstancedPool の
// per-instance color が与えるため、ここでは決めない。size による最終的な大きさは
// 個体ごとの最終的な大きさは表示ルートの scale で決まる。
function buildDebrisFragmentGeometry(rand: () => number): THREE.BufferGeometry {
  const kind = rand();
  if (kind < 0.22) {
    // 破損した外殻チャンク
    const geo = deepCloneGeometry(parseDebrisChunk().geometry);
    displaceVertices(geo, (x, y, z) => [x * (0.5 + rand() * 1.2), y * (0.5 + rand() * 1.2), z * (0.4 + rand() * 1.6)]);
    return geo;
  } else if (kind < 0.42) {
    // 平板パネル
    const geo = deepCloneGeometry(parseDebrisPanel().geometry);
    geo.scale(1.5 + rand() * 1.2, 0.06 + rand() * 0.08, 0.7 + rand() * 0.8);
    return geo;
  } else if (kind < 0.58) {
    // 構造ロッド
    const geo = deepCloneGeometry(parseDebrisRod().geometry);
    geo.scale(0.8 + rand() * 0.4, 2.2 + rand() * 1.4, 0.8 + rand() * 0.4);
    return geo;
  } else if (kind < 0.72) {
    // 歪んだ八面体
    const geo = new THREE.OctahedronGeometry(1, 0);
    displaceVertices(geo, (x, y, z) => [x * (0.5 + rand() * 1.0), y * (0.5 + rand() * 1.0), z * (0.7 + rand() * 0.9)]);
    return geo;
  } else if (kind < 0.86) {
    // 薄い歪んだ板
    const geo = new THREE.BoxGeometry(1, 1, 1);
    displaceVertices(geo, (x, y, z) => [x + (rand() - 0.5) * 0.35, y + (rand() - 0.5) * 0.35, z * 0.12]);
    geo.scale(1.2 + rand() * 1.0, 1.2 + rand() * 1.0, 0.12);
    return geo;
  } else {
    // 細い棒材
    const geo = new THREE.BoxGeometry(0.15, 1, 0.15);
    geo.scale(0.8 + rand() * 0.4, 2.0 + rand() * 1.6, 0.8 + rand() * 0.4);
    return geo;
  }
}

let debrisFragmentGeometries: THREE.BufferGeometry[] | null = null;
let debrisFragmentMaterial: THREE.MeshStandardMaterial | null = null;

// 破片(fragment)全個体が共有するジオメトリ群(バリアント)と単一マテリアルを返す。
// バリアントは初回呼び出し時に一度だけ構築する。
export function debrisFragmentResources(): { geometries: readonly THREE.BufferGeometry[]; material: THREE.Material } {
  if (!debrisFragmentGeometries) {
    const rand = mulberry32(DEBRIS_FRAGMENT_SEED);
    debrisFragmentGeometries = [];
    for (let i = 0; i < DEBRIS_FRAGMENT_VARIANT_COUNT; i++) debrisFragmentGeometries.push(buildDebrisFragmentGeometry(rand));
    debrisFragmentMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 0.65, metalness: 0.30 });
  }
  return { geometries: debrisFragmentGeometries, material: debrisFragmentMaterial! };
}


// リロード時に放出される砲身（バレル）メッシュ
// 砲身本体 + 後端フランジ + 放熱フィン + マズルブレーキ + 赤熱グロー + ガスポート
let barrelTemplate: THREE.Group | null = null;

export function buildBarrelMesh(): THREE.Group {
  if (barrelTemplate !== null) return barrelTemplate.clone(true) as THREE.Group;

  const g = new THREE.Group();
  const S = 0.7; // 直径スケール係数

  // --- 砲身チューブ本体(熱焼け黒鋼) ---
  const tubeGeo = new THREE.CylinderGeometry(0.58 * S, 0.64 * S, 4.4, 12);
  const tubeMat = new THREE.MeshStandardMaterial({ color: 0x1c2028, roughness: 0.38, metalness: 0.88 });
  const tube = new THREE.Mesh(tubeGeo, tubeMat);
  tube.rotation.x = Math.PI / 2;
  g.add(tube);

  // --- 後端フランジ(薬室側・太めリング) ---
  const flangeMat = new THREE.MeshStandardMaterial({ color: 0x2c3440, roughness: 0.42, metalness: 0.82 });
  const flange = new THREE.Mesh(new THREE.CylinderGeometry(0.88 * S, 0.85 * S, 0.32, 12), flangeMat);
  flange.rotation.x = Math.PI / 2;
  flange.position.z = -2.3;
  g.add(flange);

  // 後端中補強リング
  const midRing = new THREE.Mesh(new THREE.CylinderGeometry(0.72 * S, 0.72 * S, 0.10, 12), flangeMat);
  midRing.rotation.x = Math.PI / 2;
  midRing.position.z = -0.8;
  g.add(midRing);

  // --- 放熱フィン(6枚、後部寄りに配置) ---
  const finMat = new THREE.MeshStandardMaterial({ color: 0x252d38, roughness: 0.52, metalness: 0.78 });
  const FIN_COUNT = 6;
  for (let i = 0; i < FIN_COUNT; i++) {
    const angle = (i / FIN_COUNT) * Math.PI * 2;
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.52 * S, 1.6), finMat);
    fin.rotation.z = angle;
    fin.position.set(Math.cos(angle) * 0.90 * S, Math.sin(angle) * 0.90 * S, -0.8);
    g.add(fin);
  }

  // --- ガスポートリング(中間部) ---
  const gasPortMat = new THREE.MeshStandardMaterial({ color: 0x3a4250, roughness: 0.50, metalness: 0.72 });
  const gasPort = new THREE.Mesh(new THREE.TorusGeometry(0.66 * S, 0.065, 6, 16), gasPortMat);
  gasPort.rotation.x = Math.PI / 2;
  gasPort.position.z = 0.4;
  g.add(gasPort);

  // --- マズルブレーキ(先端3連リング) ---
  const brakeMat = new THREE.MeshStandardMaterial({ color: 0x242c38, roughness: 0.30, metalness: 0.92 });
  for (let ri = 0; ri < 3; ri++) {
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.76 * S, 0.70 * S, 0.11, 12), brakeMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.z = 1.55 + ri * 0.24;
    g.add(ring);
  }

  // --- 砲口ボア(最前端・暗い穴) ---
  const boreMat = new THREE.MeshStandardMaterial({ color: 0x080b10, roughness: 0.80, metalness: 0.20 });
  const bore = new THREE.Mesh(new THREE.CylinderGeometry(0.34 * S, 0.34 * S, 0.14, 10), boreMat);
  bore.rotation.x = Math.PI / 2;
  bore.position.z = 2.28;
  g.add(bore);

  // --- 赤熱グロー(後端・発射熱を表現) ---
  const heatMat = new THREE.MeshBasicMaterial({
    color: 0xff3c00,
    transparent: true,
    opacity: 0.48,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const heat = new THREE.Mesh(new THREE.CylinderGeometry(0.70 * S, 0.70 * S, 0.95, 10), heatMat);
  heat.rotation.x = Math.PI / 2;
  heat.position.z = -2.1;
  g.add(heat);

  barrelTemplate = g;
  // 子 mesh の geometry/material は上のテンプレートを全個体で共有する。flags は未設定でも
  // 共有扱いだが、破棄側の契約を明示して将来の個別変更で誤って解放しないようにする。
  g.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.userData.ownsGeometry = false;
    mesh.userData.ownsMaterial = false;
  });
  // layers.mask は Object3D.clone(true) が子孫までコピーするため、テンプレートへ一度だけ
  // 設定すれば以降の複製全てへ引き継がれる。
  markLitOpaque(g);
  return g;
}
