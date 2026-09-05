// プリミティブ組み合わせによるローポリ機体・弾・薬莢・デブリのメッシュ生成。
// 機体の機首は +Z 方向。
// ジオメトリ/マテリアルの構築自体は tools/export-models.mjs に移し、
// src/assets/models/*.json として事前に焼き出したものを ObjectLoader で読み込む。
import * as THREE from 'three/webgpu';
import { ENEMY_PLASMA_COLOR } from './vfx-style';
import { F0_BURNT_STEEL, F0_STEEL } from './metal-f0';
import { mulberry32 } from '../math/random';
import { markLitOpaque, markShadowCaster } from './pipeline/lit-layer';
import { attachThermalEmissive, makeThermallyEmissive, THERMAL_SHAPE_ATTRIBUTE } from './thermal-emissive';

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

// 蛇腹1折りの一辺 [m]。tools/export-models.mjs と一致させる。
export const RADIATOR_SEGMENT_LENGTH = (2.3 * 4) / 6;

// 全開時、各折りが展開軸から残す傾き。0 だと折り目の判別が数値的に不安定になるため、
// 蛇腹の折り畳みが解消された1枚の板とみなせるごく小さい値を残す。
export const RADIATOR_DEPLOY_TILT = 15 * Math.PI / 180;

export { RADIATOR_HINGE } from './radiator-hinge';

// マガジン寸法(機体座標系)。
const MAG_THICKNESS = 1.0;
const MAG_WIDTH = MAG_THICKNESS * 4 * (2 / 3); // ベルト方向(X)
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
function cloneIndependent<T extends THREE.Object3D>(template: T): T {
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
  makeThermallyEmissive(clone);
  markLitOpaque(clone);
  markShadowCaster(clone);
  return clone;
}

// data を初回だけパースしてキャッシュし、以後は cloneIndependent で複製を返すビルダーを作る。
function memoParse<T extends THREE.Object3D>(data: unknown): () => T {
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
function memoParseShared<T extends THREE.Object3D>(data: unknown): () => T {
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
let casingMaterial: THREE.MeshStandardNodeMaterial | null = null;

function initCasingResources(): void {
  if (casingGeometry && casingMaterial) return;

  const template = parseCasing();
  casingGeometry = deepCloneGeometry(template.geometry);
  casingGeometry.scale(1, 2, 1);
  casingMaterial = template.material as THREE.MeshStandardNodeMaterial;
  casingMaterial.color.setHex(0xFF9F5E);
  casingMaterial.metalness = 0.8;
  casingMaterial.roughness = 0.3;
  // 個体は 1 本の InstancedMesh へ積まれるので、温度は個体ごとの属性から読む。
  attachThermalEmissive(casingMaterial, 'instance');
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

// 軌道上の RCS 燃料補給ピックアップ。弾薬と見分けやすい黄色のタンクとビーコンで構成する。
export function buildRcsFuelPickup(): THREE.Group {
  const g = new THREE.Group();
  const tank = withDispose(new THREE.Mesh(
    new THREE.CylinderGeometry(0.45, 0.45, 1.8, 10),
    new THREE.MeshStandardMaterial({ color: 0xffb347, metalness: 0.75, roughness: 0.3 }),
  ));
  tank.rotation.z = Math.PI / 2;
  g.add(tank);

  const band = withDispose(new THREE.Mesh(
    new THREE.TorusGeometry(0.46, 0.06, 6, 12),
    new THREE.MeshStandardMaterial({ color: 0xffe0a3, metalness: 0.8, roughness: 0.25 }),
  ));
  band.rotation.y = Math.PI / 2;
  g.add(band);

  const beacon = withDispose(new THREE.Mesh(
    new THREE.OctahedronGeometry(0.28, 0),
    new THREE.MeshBasicMaterial({ color: 0xffd166 }),
  ));
  beacon.position.x = 1.15;
  g.add(beacon);
  makeThermallyEmissive(g);
  markLitOpaque(g);
  markShadowCaster(g);
  return g;
}

// userData.role === 'accent' が付与されたマテリアルだけを accent 色へ塗り替える。
function tintAccentMaterials(g: THREE.Group, accent: string | number): void {
  g.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = mesh.material as THREE.Material & { color?: THREE.Color };
    if (mat && mat.userData && mat.userData.role === 'accent' && mat.color) {
      mat.color.set(accent);
    }
  });
}

// 敵機: プレースホルダの基本色で焼き出されたテンプレートのうち、
// userData.role === 'accent' が付与されたマテリアルだけを accent 色へ塗り替える。
export function buildEnemyShip(accent: string | number = 0xff4a3d): THREE.Group {
  const g = parseEnemy();
  tintAccentMaterials(g, accent);
  return g;
}

// stage0 敵機のメッシュを typeIndex(0〜2)の機体テンプレートから生成し、accent 色に塗り替える。
export function buildStage0EnemyShip(accent: string | number = 0x3dc6ff, typeIndex = 0): THREE.Group {
  let g: THREE.Group;
  // typeIndex で機体テンプレートを選ぶ
  if (typeIndex === 1) g = parseStage0EnemyB();
  else if (typeIndex === 2) g = parseStage0EnemyC();
  else g = parseStage0EnemyA();

  tintAccentMaterials(g, accent);
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
      // 明るさは色に載せ、不透明度は 1 のままにする(render/billboard.ts と同じ規約)。
      color: new THREE.Color(0xffc86e).multiplyScalar(0.35),
      transparent: true,
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

let plasmaBodyMat: THREE.MeshBasicMaterial | null = null;

// 敵プラズマ弾のメッシュ(本体のみ)を生成する。マテリアルは1つキャッシュして全弾で共有する。
export function buildPlasmaMesh(): THREE.Mesh {
  const m = parsePlasma();
  // export-models.mjs で CylinderGeometry の長さ軸を +Z へ回してから
  // BufferGeometry として書き出している。BufferGeometry の頂点座標には
  // その回転が焼き込まれているため、ここで再度 rotateX() してはならない。
  if (!plasmaBodyMat) {
    plasmaBodyMat = new THREE.MeshBasicMaterial({
      color: ENEMY_PLASMA_COLOR,
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
// 個体ごとに乱数でジオメトリを作ることはしない — 起動時に一度だけ
// DEBRIS_FRAGMENT_VARIANT_COUNT 種類のジオメトリ(単位スケール)を焼き、色は InstancedPool の
// per-instance color で個体ごとに与える(debrisFragmentResources)。

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
// バリアント1本につき InstancedPool が1本増え、G バッファと影パスのシェーダが1本ずつ
// 起動時にコンパイルされるので、増やすほど起動が伸びる。**7 を下回らせない** — 形の帯を
// 等間隔に叩くので、これより少ないと 6 つの形のどれかが 1 本も出なくなる。
export const DEBRIS_FRAGMENT_VARIANT_COUNT = 7;
// バリアントの寸法を決める乱数のシード(起動のたびに形が変わらないよう固定する)。
const DEBRIS_FRAGMENT_SEED = 0xdeb71;

// 破片ジオメトリを1つ、単位スケールで生成する。kind [0, 1) が6つの形のどれになるかを決め、
// rand が寸法の細部を決める。色は個体ごとに InstancedPool の per-instance color が
// 与えるため、ここでは決めない。個体ごとの最終的な大きさは表示ルートの scale で決まる。
function buildDebrisFragmentGeometry(rand: () => number, kind: number): THREE.BufferGeometry {
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
let debrisFragmentMaterial: THREE.MeshStandardNodeMaterial | null = null;

// 破片(fragment)全個体が共有するジオメトリ群(バリアント)と単一マテリアルを返す。
// バリアントは初回呼び出し時に一度だけ構築する。
export function debrisFragmentResources(): { geometries: readonly THREE.BufferGeometry[]; material: THREE.Material } {
  if (!debrisFragmentGeometries) {
    const rand = mulberry32(DEBRIS_FRAGMENT_SEED);
    debrisFragmentGeometries = [];
    // 形の帯を等間隔に叩く。乱択だと本数が少ないときに同じ形へ偏る。
    for (let i = 0; i < DEBRIS_FRAGMENT_VARIANT_COUNT; i++) {
      debrisFragmentGeometries.push(
        buildDebrisFragmentGeometry(rand, (i + 0.5) / DEBRIS_FRAGMENT_VARIANT_COUNT));
    }
    debrisFragmentMaterial = attachThermalEmissive(
      new THREE.MeshStandardNodeMaterial({ color: 0xffffff, flatShading: true, roughness: 0.65, metalness: 0 }),
      'instance');
  }
  return { geometries: debrisFragmentGeometries, material: debrisFragmentMaterial! };
}


// リロード時に放出される砲身（バレル）メッシュ
// 砲身本体 + 後端フランジ + 放熱フィン + マズルブレーキ + ガスポート

// 薬室の位置 [m] と、そこから砲口へ向かって温度差が落ちる長さ [m]。発射ガスは銃身に沿って
// 熱を置いていくので、薬室側がいちばん熱く、砲口へ向かって指数で下がる。
const BARREL_BREECH_Z = -2.3;
const BARREL_HEAT_FALLOFF = 1.2;

// 砲身の各メッシュへ、平均温度からの温度差の分布(薬室側 1、砲口側 0)を焼く。
function bakeBarrelThermalShape(root: THREE.Object3D): void {
  const vertex = new THREE.Vector3();
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.updateMatrix();
    const position = mesh.geometry.getAttribute('position');
    const shape = new Float32Array(position.count);
    for (let i = 0; i < position.count; i++) {
      vertex.fromBufferAttribute(position, i).applyMatrix4(mesh.matrix);
      shape[i] = Math.min(1, Math.exp(-(vertex.z - BARREL_BREECH_Z) / BARREL_HEAT_FALLOFF));
    }
    mesh.geometry.setAttribute(THERMAL_SHAPE_ATTRIBUTE, new THREE.Float32BufferAttribute(shape, 1));
  });
}

let barrelTemplate: THREE.Group | null = null;

export function buildBarrelMesh(): THREE.Group {
  if (barrelTemplate !== null) return barrelTemplate.clone(true) as THREE.Group;

  const g = new THREE.Group();
  const S = 0.7; // 直径スケール係数

  // --- 砲身チューブ本体(熱焼け黒鋼) ---
  const tubeGeo = new THREE.CylinderGeometry(0.58 * S, 0.64 * S, 4.4, 12);
  const tubeMat = new THREE.MeshStandardMaterial({ color: F0_BURNT_STEEL, roughness: 0.38, metalness: 1 });
  const tube = new THREE.Mesh(tubeGeo, tubeMat);
  tube.rotation.x = Math.PI / 2;
  g.add(tube);

  // --- 後端フランジ(薬室側・太めリング) ---
  const flangeMat = new THREE.MeshStandardMaterial({ color: F0_STEEL, roughness: 0.42, metalness: 1 });
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
  const finMat = new THREE.MeshStandardMaterial({ color: F0_BURNT_STEEL, roughness: 0.52, metalness: 1 });
  const FIN_COUNT = 6;
  for (let i = 0; i < FIN_COUNT; i++) {
    const angle = (i / FIN_COUNT) * Math.PI * 2;
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.52 * S, 1.6), finMat);
    fin.rotation.z = angle;
    fin.position.set(Math.cos(angle) * 0.90 * S, Math.sin(angle) * 0.90 * S, -0.8);
    g.add(fin);
  }

  // --- ガスポートリング(中間部) ---
  const gasPortMat = new THREE.MeshStandardMaterial({ color: F0_STEEL, roughness: 0.50, metalness: 1 });
  const gasPort = new THREE.Mesh(new THREE.TorusGeometry(0.66 * S, 0.065, 6, 16), gasPortMat);
  gasPort.rotation.x = Math.PI / 2;
  gasPort.position.z = 0.4;
  g.add(gasPort);

  // --- マズルブレーキ(先端3連リング) ---
  const brakeMat = new THREE.MeshStandardMaterial({ color: F0_STEEL, roughness: 0.30, metalness: 1 });
  for (let ri = 0; ri < 3; ri++) {
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.76 * S, 0.70 * S, 0.11, 12), brakeMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.z = 1.55 + ri * 0.24;
    g.add(ring);
  }

  // --- 砲口ボア(最前端・暗い穴) ---
  // 発射煙のすすで覆われた内壁なので金属ではない。ベース色は拡散アルベドとして読まれる。
  const boreMat = new THREE.MeshStandardMaterial({ color: 0x080b10, roughness: 0.80, metalness: 0 });
  const bore = new THREE.Mesh(new THREE.CylinderGeometry(0.34 * S, 0.34 * S, 0.14, 10), boreMat);
  bore.rotation.x = Math.PI / 2;
  bore.position.z = 2.28;
  g.add(bore);

  bakeBarrelThermalShape(g);
  makeThermallyEmissive(g);
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
  markShadowCaster(g);
  return g;
}
