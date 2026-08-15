// プリミティブ組み合わせによるローポリ機体・弾・薬莢・デブリのメッシュ生成。
// 機体の機首は +Z 方向。
// ジオメトリ/マテリアルの構築自体は tools/export-models.mjs に移し、
// src/assets/models/*.json として事前に焼き出したものを ObjectLoader で読み込む。
import * as THREE from 'three/webgpu';
import * as C from '../game/const';
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
    plasmaBodyMat = (m.material as THREE.MeshBasicMaterial).clone();
    plasmaBodyMat.color.set(C.COLOR_ENEMY_PLASMA);
    // 不透明にするため AdditiveBlending は設定しない
    plasmaBodyMat.transparent = false;
    plasmaBodyMat.opacity = 1.0;
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

// 不定形の岩塊メッシュ(小惑星用)。二十面体を軸ごとに独立した比率でランダムに歪ませ、
// 人工物のディテールを持たない塊状の見た目にする。radius は歪ませる前の平均半径 [m]。
export function buildAsteroidMesh(radius: number): THREE.Mesh {
  const geo = new THREE.IcosahedronGeometry(radius, 1);
  displaceVertices(geo, (x, y, z) => [
    x * (0.7 + Math.random() * 0.6),
    y * (0.7 + Math.random() * 0.6),
    z * (0.7 + Math.random() * 0.6),
  ]);
  const mat = new THREE.MeshStandardMaterial({ color: 0x8a8378, flatShading: true, roughness: 0.9, metalness: 0.05 });
  const mesh = withDispose(new THREE.Mesh(geo, mat));
  // このメッシュは cloneIndependent を経由しないので、自分で G バッファ対象へ加える。
  markLitOpaque(mesh);
  return mesh;
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

// 基地: 中央ハブ + 放射状トラス4本 + ドッキングモジュール4基 + 太陽電池パドル2枚の低ポリ構成。
// 基地: 3倍スケール対応・超大型白基調ステーション (純白エアロスペースカラー・200箱不規則貨物マトリックス・化学蒸留プラント・シダの葉太陽電池・SAR)
export function buildBaseModel(): THREE.Group {
  const g = new THREE.Group();

  // マテリアル定義 (全構造を清潔感あふれるセラミックホワイト・シルバーチタン白系で統一)
  const redTrussMat = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, flatShading: true, roughness: 0.25, metalness: 0.45 }); // 白基調主トラス構造
  const grayFrameMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, flatShading: true, roughness: 0.2, metalness: 0.35 });  // 白基調外骨格
  const whiteModuleMat = new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 0.15, metalness: 0.25 }); // 純白セラミック居住区
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.35, roughness: 0.1, metalness: 0.9 });
  const radiatorMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, flatShading: true, roughness: 0.15, metalness: 0.9 });

  // ディテール追加用マテリアル (白系基調のライトアロイ)
  const conduitMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, flatShading: true, roughness: 0.3, metalness: 0.7 });
  const conduitJointMat = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, flatShading: true, roughness: 0.35, metalness: 0.75 });
  const windowGlowMat = new THREE.MeshStandardMaterial({ color: 0xfef08a, emissive: 0xfde047, emissiveIntensity: 0.95, roughness: 0.2 });
  const sensorPodMat = new THREE.MeshStandardMaterial({ color: 0x64748b, flatShading: true, roughness: 0.3, metalness: 0.7 });
  const panelGrooveMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, flatShading: true, roughness: 0.7, metalness: 0.3 });
  const navRedMat = new THREE.MeshStandardMaterial({ color: 0xef4444, emissive: 0xf87171, emissiveIntensity: 1.2 });
  const navGreenMat = new THREE.MeshStandardMaterial({ color: 0x10b981, emissive: 0x34d399, emissiveIntensity: 1.2 });

  // コンテナ・タンク群用カラーパレット (統一感のあるホワイト・シルバー・プラチナ基調)
  const containerMats = [
    new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 0.25, metalness: 0.35 }), // ピュアホワイト
    new THREE.MeshStandardMaterial({ color: 0xf8fafc, flatShading: true, roughness: 0.3, metalness: 0.4 }),   // セラミックホワイト
    new THREE.MeshStandardMaterial({ color: 0xf1f5f9, flatShading: true, roughness: 0.35, metalness: 0.45 }), // エアロスペースホワイト
    new THREE.MeshStandardMaterial({ color: 0xe2e8f0, flatShading: true, roughness: 0.3, metalness: 0.6 }),   // シルバーホワイト
    new THREE.MeshStandardMaterial({ color: 0xcbd5e1, flatShading: true, roughness: 0.35, metalness: 0.7 }),  // ライトプラチナ
    new THREE.MeshStandardMaterial({ color: 0x94a3b8, flatShading: true, roughness: 0.4, metalness: 0.65 }),  // ピューターアクセント
  ];
  const neonAccentMat = new THREE.MeshStandardMaterial({ color: 0x0ea5e9, emissive: 0x38bdf8, emissiveIntensity: 0.8 });
  const hazardOrangeMat = new THREE.MeshStandardMaterial({ color: 0xd97706, emissive: 0xf59e0b, emissiveIntensity: 0.7 });

  const tankMats = [
    new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 0.2, metalness: 0.8 }),  // ピュアホワイトタンク
    new THREE.MeshStandardMaterial({ color: 0xf1f5f9, flatShading: true, roughness: 0.25, metalness: 0.75 }), // シルバーホワイトタンク
    new THREE.MeshStandardMaterial({ color: 0xe2e8f0, flatShading: true, roughness: 0.25, metalness: 0.7 }),  // プラチナホワイトタンク
  ];

  // 1) 現状の倍の長さ (340m) & 鉄塔風・超高密度立体格子トラス構造 (Steel Transmission Tower Lattice)
  const trussRadius = 9;
  const trussLength = 340;
  const trussCenterZ = 25;
  const zMin = trussCenterZ - trussLength / 2; // -145m
  const zMax = trussCenterZ + trussLength / 2; // +195m

  // 主ビーム (縦方向コード 3本 + 内側面補強ストリンガー 3本)
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const cosA = Math.cos(a);
    const sinA = Math.sin(a);

    // 主コードビーム
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, trussLength, 6), redTrussMat);
    beam.position.set(cosA * trussRadius, sinA * trussRadius, trussCenterZ);
    beam.rotation.x = Math.PI / 2;
    g.add(beam);

    // 内側面補強ストリンガー
    const innerBeam = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, trussLength, 6), redTrussMat);
    innerBeam.position.set(cosA * (trussRadius * 0.5), sinA * (trussRadius * 0.5), trussCenterZ);
    innerBeam.rotation.x = Math.PI / 2;
    g.add(innerBeam);

    // 沿う流体配管パイプライン
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, trussLength + 4, 6), conduitMat);
    pipe.position.set(cosA * (trussRadius + 1.8), sinA * (trussRadius + 1.8), trussCenterZ);
    pipe.rotation.x = Math.PI / 2;
    g.add(pipe);

    // 配管フランジ継手リング (12mおき)
    for (let pz = zMin; pz <= zMax; pz += 12) {
      const joint = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.48, 0.6, 8), conduitJointMat);
      joint.position.set(cosA * (trussRadius + 1.8), sinA * (trussRadius + 1.8), pz);
      joint.rotation.x = Math.PI / 2;
      g.add(joint);
    }
  }

  // 鉄塔風・立体Xクロスラティス & 横方向バルクヘッドリング & 内部Kブレース
  const stepZ = 10;
  for (let z = zMin; z < zMax; z += stepZ) {
    const zNext = z + stepZ;

    for (let i = 0; i < 3; i++) {
      const a1 = (i / 3) * Math.PI * 2;
      const a2 = (((i + 1) % 3) / 3) * Math.PI * 2;

      const p1 = new THREE.Vector3(Math.cos(a1) * trussRadius, Math.sin(a1) * trussRadius, z);
      const p2 = new THREE.Vector3(Math.cos(a2) * trussRadius, Math.sin(a2) * trussRadius, z);
      const p1Next = new THREE.Vector3(Math.cos(a1) * trussRadius, Math.sin(a1) * trussRadius, zNext);
      const p2Next = new THREE.Vector3(Math.cos(a2) * trussRadius, Math.sin(a2) * trussRadius, zNext);

      // 横方向リブ（バルクヘッド枠）
      const hMid = p1.clone().add(p2).multiplyScalar(0.5);
      const hLen = p1.distanceTo(p2);
      const hStrut = new THREE.Mesh(new THREE.CylinderGeometry(0.65, 0.65, hLen, 4), redTrussMat);
      hStrut.position.copy(hMid);
      hStrut.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p2.clone().sub(p1).normalize());
      g.add(hStrut);

      // 斜めXブレース (対角線1: p1 -> p2Next)
      const dMid1 = p1.clone().add(p2Next).multiplyScalar(0.5);
      const dLen1 = p1.distanceTo(p2Next);
      const dStrut1 = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, dLen1, 4), redTrussMat);
      dStrut1.position.copy(dMid1);
      dStrut1.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p2Next.clone().sub(p1).normalize());
      g.add(dStrut1);

      // 斜めXブレース (対角線2: p2 -> p1Next)
      const dMid2 = p2.clone().add(p1Next).multiplyScalar(0.5);
      const dLen2 = p2.distanceTo(p1Next);
      const dStrut2 = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, dLen2, 4), redTrussMat);
      dStrut2.position.copy(dMid2);
      dStrut2.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p1Next.clone().sub(p2).normalize());
      g.add(dStrut2);

      // 内部放射状Kブレース (中心軸 z -> ノード p1)
      const centerNode = new THREE.Vector3(0, 0, z);
      const kMid = centerNode.clone().add(p1).multiplyScalar(0.5);
      const kLen = centerNode.distanceTo(p1);
      const kStrut = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, kLen, 4), conduitJointMat);
      kStrut.position.copy(kMid);
      kStrut.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p1.clone().sub(centerNode).normalize());
      g.add(kStrut);

      // 節点ガセットジョイント (Node Gusset Hub)
      const nodeHub = new THREE.Mesh(new THREE.SphereGeometry(0.9, 8, 8), conduitJointMat);
      nodeHub.position.copy(p1);
      g.add(nodeHub);
    }
  }

  // 2) 大型放熱板 (トラス部中腹)
  for (const side of [1, -1]) {
    const radiator = new THREE.Mesh(new THREE.BoxGeometry(45, 0.8, 22), radiatorMat);
    radiator.position.set(side * 28, 0, 30);
    g.add(radiator);

    // ギミック関節
    const mountJoint = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 3.5, 10), sensorPodMat);
    mountJoint.position.set(side * 8, 0, 30);
    mountJoint.rotation.z = Math.PI / 2;
    g.add(mountJoint);
  }

  // 3) 中腹ドッキング部 (Z = 0m)
  const dockPalletMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, flatShading: true, roughness: 0.2, metalness: 0.3 });

  // 中央メインドッキングハッチ (Y = +6m, Z = 0)
  const hatchDoor = new THREE.Mesh(new THREE.CylinderGeometry(10, 10, 2, 16), dockPalletMat);
  hatchDoor.position.set(0, 7, 0);
  g.add(hatchDoor);

  // 【一箇所に集約した2x2格子状ドッキングベイスロット (Dock 0..3)】
  const gridSlotPos = [
    { x: -11, z: -14 }, // Slot 0
    { x:  11, z: -14 }, // Slot 1
    { x: -11, z:  14 }, // Slot 2
    { x:  11, z:  14 }, // Slot 3
  ];

  let sIdx = 0;
  for (const slotPos of gridSlotPos) {
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 5.0, 1.2, 12), dockPalletMat);
    collar.position.set(slotPos.x, 7.2, slotPos.z);
    g.add(collar);

    // 航行ガイドビーコンライト (赤/緑)
    const beaconMat = sIdx % 2 === 0 ? navRedMat : navGreenMat;
    const beaconLight = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), beaconMat);
    beaconLight.position.set(slotPos.x, 8.2, slotPos.z);
    g.add(beaconLight);

    sIdx++;
  }

  // 4) 主要部 (居住区 + クライレスラービル風アールデコ装飾 + 研究所観測ドーム $22 \times 22 \times 52$m, Z = +50m 〜 +100m)
  const mainCenterZ = 75;
  // 白基調外骨格フレーム
  const exoskeleton = new THREE.Mesh(new THREE.BoxGeometry(22, 22, 52), grayFrameMat);
  exoskeleton.position.set(0, 0, mainCenterZ);
  g.add(exoskeleton);

  // 【クライスラービル風アールデコ・ディテール】
  // 1) 垂直ピアーモールディング (Vertical Piers & Recessed Seams)
  for (const px of [-11.1, -5.5, 0, 5.5, 11.1]) {
    for (const py of [-11.1, 11.1]) {
      const vPier = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 50), conduitMat);
      vPier.position.set(px, py, mainCenterZ);
      g.add(vPier);

      const vPierY = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.5, 50), conduitMat);
      vPierY.position.set(py, px, mainCenterZ);
      g.add(vPierY);
    }
  }

  // 2) 段層セットバックモールディング (Terraced Step-back Moldings)
  for (let zStep = mainCenterZ - 20; zStep <= mainCenterZ + 20; zStep += 10) {
    const stepMolding = new THREE.Mesh(new THREE.BoxGeometry(22.8, 22.8, 0.8), grayFrameMat);
    stepMolding.position.set(0, 0, zStep);
    g.add(stepMolding);

    const seamRing = new THREE.Mesh(new THREE.BoxGeometry(23.2, 23.2, 0.25), panelGrooveMat);
    seamRing.position.set(0, 0, zStep);
    g.add(seamRing);

    // ホイールキャップ型メダリオンレリーフ (Wheel-cap Medallions)
    for (const mx of [-11.5, 11.5]) {
      const medallion = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 0.3, 12), conduitJointMat);
      medallion.position.set(mx, 0, zStep);
      medallion.rotation.z = Math.PI / 2;
      g.add(medallion);

      const medallionY = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 0.3, 12), conduitJointMat);
      medallionY.position.set(0, mx, zStep);
      medallionY.rotation.x = Math.PI / 2;
      g.add(medallionY);
    }
  }

  // 3) ガーゴイル風・翼状コーナーアビオニクススパイア (Eagle-head Gargoyle Corner Spires)
  for (const gx of [-11.8, 11.8]) {
    for (const gy of [-11.8, 11.8]) {
      const gargoyleSpire = new THREE.Mesh(new THREE.ConeGeometry(1.8, 7.0, 4), radiatorMat);
      gargoyleSpire.position.set(gx * 1.08, gy * 1.08, mainCenterZ + 18);
      gargoyleSpire.rotation.x = Math.PI / 2 + 0.3;
      gargoyleSpire.rotation.z = Math.atan2(gy, gx);
      g.add(gargoyleSpire);
    }
  }

  // 4) サンバースト冠状アールデコアーチ (Sunburst Crown Radiac Arch Ribs)
  for (let aIdx = 0; aIdx < 4; aIdx++) {
    const archRadius = 11 - aIdx * 1.8;
    const archZ = mainCenterZ + 20 + aIdx * 1.5;
    const crownArch = new THREE.Mesh(new THREE.CylinderGeometry(archRadius, archRadius + 0.6, 0.8, 16), grayFrameMat);
    crownArch.position.set(0, 0, archZ);
    g.add(crownArch);

    const archGroove = new THREE.Mesh(new THREE.CylinderGeometry(archRadius + 0.7, archRadius + 0.7, 0.2, 16), panelGrooveMat);
    archGroove.position.set(0, 0, archZ);
    g.add(archGroove);
  }

  // 【ディテール: 計測機器ポッド (Sensor / Avionics pods) 4箇所】
  for (const sx of [-11.3, 11.3]) {
    for (const sy of [-11.3, 11.3]) {
      const pod = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 6), sensorPodMat);
      pod.position.set(sx, sy, mainCenterZ);
      g.add(pod);

      // ポッド先端のセンサーレンズ
      const lens = new THREE.Mesh(new THREE.SphereGeometry(0.6, 8, 6), neonAccentMat);
      lens.position.set(sx, sy, mainCenterZ + 3.2);
      g.add(lens);
    }
  }

  // 居住区 (白い円筒が正方形プランで複雑に接合)
  const gridPositions = [-6, 0, 6];
  for (const x of gridPositions) {
    for (const y of gridPositions) {
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.5, 40, 8), whiteModuleMat);
      tube.position.set(x, y, mainCenterZ - 3);
      tube.rotation.x = Math.PI / 2;
      g.add(tube);

      // 【ディテール: 小さな発光窓 (Portholes / Illuminated Windows)】
      for (let zWin = mainCenterZ - 18; zWin <= mainCenterZ + 12; zWin += 6) {
        if (Math.abs(x) === 6 || Math.abs(y) === 6) {
          const winAngle = Math.atan2(y, x);
          const winX = x + Math.cos(winAngle) * 2.52;
          const winY = y + Math.sin(winAngle) * 2.52;
          const win = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.7, 0.35), windowGlowMat);
          win.position.set(winX, winY, zWin);
          g.add(win);
        }
      }
    }
  }

  // 【幾何学的配管ネットワーク (合流・分岐する樹状管構造)】
  // 主幹パイプライン (幹)
  for (const pipeX of [-6.8, 6.8]) {
    const mainPipe = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 46, 8), conduitMat);
    mainPipe.position.set(pipeX, 6.8, mainCenterZ);
    mainPipe.rotation.x = Math.PI / 2;
    g.add(mainPipe);

    // 45度分岐マニホールド Joint
    for (let zJ = mainCenterZ - 15; zJ <= mainCenterZ + 15; zJ += 15) {
      const jointHub = new THREE.Mesh(new THREE.SphereGeometry(0.75, 8, 8), conduitJointMat);
      jointHub.position.set(pipeX, 6.8, zJ);
      g.add(jointHub);

      // 分岐枝パイプ (モジュール外周をまわるループ)
      const branchPipe = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 14, 6), conduitMat);
      branchPipe.position.set(pipeX / 2, 6.8, zJ);
      branchPipe.rotation.z = Math.PI / 2;
      g.add(branchPipe);
    }
  }

  // 研究所・天体観測ドーム (純粋な強化ガラス観測デッキ)
  const obsDome = new THREE.Mesh(new THREE.SphereGeometry(8, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), glassMat);
  obsDome.position.set(0, 0, mainCenterZ + 25);
  obsDome.rotation.x = -Math.PI / 2;
  g.add(obsDome);

  // 観測ドーム内部の研究コンソール
  const obsCore = new THREE.Mesh(new THREE.CylinderGeometry(3.5, 3.5, 6, 10), sensorPodMat);
  obsCore.position.set(0, 0, mainCenterZ + 23);
  obsCore.rotation.x = Math.PI / 2;
  g.add(obsCore);

  // 【センサー・アンテナ群 (磁気センサーブーム)】

  // 2) 磁気センサー (Magnetometer Boom - 長尺ブーム先端の3軸センサー)
  const magBoom = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.15, 45, 6), redTrussMat);
  magBoom.position.set(0, 0, mainCenterZ + 48);
  magBoom.rotation.x = Math.PI / 2;
  g.add(magBoom);

  // 3軸磁気センサーキューブ
  const magCube = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1.4), sensorPodMat);
  magCube.position.set(0, 0, mainCenterZ + 70.5);
  g.add(magCube);

  for (const magAxis of [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 1),
  ]) {
    const tipProbe = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.5, 6), neonAccentMat);
    tipProbe.position.set(0, 0, mainCenterZ + 70.5).add(magAxis.clone().multiplyScalar(1.5));
    g.add(tipProbe);
  }


  // 5) カウンターウェイト部 (化学蒸留プラントコンプレックス + 200箱貨物コンテナ群 Z = -120m 〜 -40m)
  const cwCenterZ = -75;
  const cwCore = new THREE.Mesh(new THREE.BoxGeometry(14, 14, 68), grayFrameMat);
  cwCore.position.set(0, 0, cwCenterZ);
  g.add(cwCore);

  // 【化学プラント / 蒸留塔 (Distillation Towers Complex)】
  // 蒸留塔 1 (フランジリング・凝縮器・リフレクションライン付き)
  const tower1 = new THREE.Mesh(new THREE.CylinderGeometry(5.5, 5.5, 50, 16), tankMats[0]!);
  tower1.position.set(13, 13, cwCenterZ - 5);
  tower1.rotation.x = Math.PI / 2;
  g.add(tower1);

  // 蒸留塔の段数フランジリング
  for (let zFlange = cwCenterZ - 28; zFlange <= cwCenterZ + 18; zFlange += 5) {
    const flange = new THREE.Mesh(new THREE.CylinderGeometry(6.3, 6.3, 0.5, 16), conduitJointMat);
    flange.position.set(13, 13, zFlange);
    flange.rotation.x = Math.PI / 2;
    g.add(flange);

    // キャットウォーク作業足場
    if ((zFlange - cwCenterZ) % 15 === 0) {
      const catwalk = new THREE.Mesh(new THREE.CylinderGeometry(8.5, 8.5, 0.4, 12), conduitMat);
      catwalk.position.set(13, 13, zFlange);
      catwalk.rotation.x = Math.PI / 2;
      g.add(catwalk);
    }
  }

  // 蒸留塔 2
  const tower2 = new THREE.Mesh(new THREE.CylinderGeometry(4.8, 4.8, 42, 14), tankMats[1]!);
  tower2.position.set(-13, -13, cwCenterZ + 2);
  tower2.rotation.x = Math.PI / 2;
  g.add(tower2);

  for (let zFlange = cwCenterZ - 18; zFlange <= cwCenterZ + 20; zFlange += 6) {
    const flange = new THREE.Mesh(new THREE.CylinderGeometry(5.5, 5.5, 0.5, 14), conduitJointMat);
    flange.position.set(-13, -13, zFlange);
    flange.rotation.x = Math.PI / 2;
    g.add(flange);
  }

  // 高圧球形ガスタンク (3基)
  const sphereTankPositions: readonly [number, number, number][] = [[-13, 13, -15], [13, -13, 10], [0, 15, -25]];
  for (const [sX, sY, sZ] of sphereTankPositions) {
    const sphereTank = new THREE.Mesh(new THREE.SphereGeometry(6.0, 14, 12), tankMats[2]!);
    sphereTank.position.set(sX, sY, cwCenterZ + sZ);
    g.add(sphereTank);

    // 接続バルブ
    const valve = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 2, 8), hazardOrangeMat);
    valve.position.set(sX, sY + 6.2, cwCenterZ + sZ);
    g.add(valve);
  }

  // 【コンテナ生成用ヘルパー】ISO規格リアル宇宙貨物コンテナ
  const buildContainer = (w: number, h: number, d: number, mat: THREE.Material, tagMat?: THREE.Material): THREE.Group => {
    const container = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    container.add(body);

    // 8箇所のコーナーキャスティング (ISO 規格角型金具)
    const cSize = Math.min(w, h, d) * 0.16;
    const cornerGeo = new THREE.BoxGeometry(cSize, cSize, cSize);
    const cornerMat = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, flatShading: true, roughness: 0.3, metalness: 0.8 });
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const corner = new THREE.Mesh(cornerGeo, cornerMat);
          corner.position.set(sx * (w / 2), sy * (h / 2), sz * (d / 2));
          container.add(corner);
        }
      }
    }

    // 側面の波板コルゲート構造 (Corrugated Wall Ribs)
    const grooveMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, flatShading: true, roughness: 0.6, metalness: 0.3 });
    const ribCount = Math.max(3, Math.floor(d / 1.6));
    for (let i = 0; i < ribCount; i++) {
      const zPos = -d / 2 + ((i + 0.5) * d) / ribCount;
      for (const sx of [-1, 1]) {
        const rib = new THREE.Mesh(new THREE.BoxGeometry(0.12, h * 0.85, 0.45), grooveMat);
        rib.position.set(sx * (w / 2 + 0.04), 0, zPos);
        container.add(rib);
      }
    }

    // 後部ダブルドア・ツインロックバー
    const doorZ = d / 2 + 0.05;
    const doorSeam = new THREE.Mesh(new THREE.BoxGeometry(0.08, h * 0.88, 0.12), grooveMat);
    doorSeam.position.set(0, 0, doorZ);
    container.add(doorSeam);

    const barGeo = new THREE.CylinderGeometry(0.08, 0.08, h * 0.82, 6);
    const barMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, flatShading: true, roughness: 0.2, metalness: 0.9 });
    for (const bx of [-w * 0.24, w * 0.24]) {
      const lockBar = new THREE.Mesh(barGeo, barMat);
      lockBar.position.set(bx, 0, doorZ);
      container.add(lockBar);

      // ロックハンドレバー
      const handle = new THREE.Mesh(new THREE.BoxGeometry(w * 0.18, 0.08, 0.1), barMat);
      handle.position.set(bx + (bx > 0 ? -w * 0.08 : w * 0.08), -h * 0.15, doorZ + 0.04);
      container.add(handle);
    }

    // コンテナID標識タグ
    if (tagMat) {
      const tag = new THREE.Mesh(new THREE.BoxGeometry(w * 0.35, h * 0.25, 0.1), tagMat);
      tag.position.set(w * 0.22, h * 0.22, doorZ + 0.02);
      container.add(tag);
    }

    return container;
  };

  // 【多彩な貨物ビルダー: 8種類の多様な規格化宇宙貨物モジュール (白系基調)】
  const buildAdvancedCargoGroup = (typeIdx: number, mat: THREE.Material, tagMat?: THREE.Material): THREE.Group => {
    const cargo = new THREE.Group();
    const kind = typeIdx % 8;

    if (kind === 0) {
      // 1) Dry ISO Box (標準ドライコンテナ)
      cargo.add(buildContainer(4.5, 4.5, 9.0, mat, tagMat));
    } else if (kind === 1) {
      // 2) Reefer (冷凍コンテナ)
      const reeferMat = containerMats[0]!;
      const c = buildContainer(4.5, 4.8, 9.0, reeferMat, tagMat);
      const cooler = new THREE.Mesh(new THREE.BoxGeometry(4.0, 4.0, 0.4), sensorPodMat);
      cooler.position.set(0, 0, -4.5);
      c.add(cooler);
      const coolerLed = new THREE.Mesh(new THREE.SphereGeometry(0.3, 6, 6), neonAccentMat);
      coolerLed.position.set(1.5, 1.5, -4.7);
      c.add(coolerLed);
      cargo.add(c);
    } else if (kind === 2) {
      // 3) ISO Tanktainer (フレーム内蔵円筒圧力タンク)
      const w = 4.5, h = 4.5, d = 9.0;
      const frameMat = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, flatShading: true, roughness: 0.3, metalness: 0.8 });
      const frame = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), frameMat);
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.0, 8.4, 12), mat);
      tank.rotation.x = Math.PI / 2;
      cargo.add(tank);
      for (const sz of [-4.2, 4.2]) {
        const cap = new THREE.Mesh(new THREE.SphereGeometry(2.0, 12, 8), mat);
        cap.position.set(0, 0, sz);
        cargo.add(cap);
      }
      cargo.add(frame);
    } else if (kind === 3) {
      // 4) Flat-Rack Heavy Payload (フラットラック重量機器)
      const w = 4.5, h = 1.0, d = 9.0;
      const bed = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), containerMats[1]!);
      cargo.add(bed);
      const machine = new THREE.Mesh(new THREE.BoxGeometry(3.6, 3.2, 7.0), sensorPodMat);
      machine.position.set(0, 2.1, 0);
      cargo.add(machine);
      for (const zS of [-2.5, 0, 2.5]) {
        const strap = new THREE.Mesh(new THREE.BoxGeometry(3.8, 3.4, 0.3), hazardOrangeMat);
        strap.position.set(0, 2.0, zS);
        cargo.add(strap);
      }
    } else if (kind === 4) {
      // 5) Gas Bottle Pack (集合高圧ボンベラック)
      const w = 4.5, h = 4.5, d = 9.0;
      const frame = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), containerMats[3]!);
      cargo.add(frame);
      for (const bx of [-1.2, 1.2]) {
        for (const by of [-1.2, 1.2]) {
          const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 8.0, 10), tankMats[1]!);
          bottle.position.set(bx, by, 0);
          bottle.rotation.x = Math.PI / 2;
          cargo.add(bottle);
        }
      }
    } else if (kind === 5) {
      // 6) Spherical Fuel Pod Cluster (ツイン球形液体燃料ポッドセル)
      const w = 4.5, h = 4.5, d = 9.0;
      const frameMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, flatShading: true, roughness: 0.3, metalness: 0.7 });
      const frame = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), frameMat);
      cargo.add(frame);
      for (const zSph of [-2.2, 2.2]) {
        const sphereTank = new THREE.Mesh(new THREE.SphereGeometry(1.9, 12, 10), tankMats[0]!);
        sphereTank.position.set(0, 0, zSph);
        cargo.add(sphereTank);
      }
    } else if (kind === 6) {
      // 7) Hexagonal Prism Cargo Vault (六角柱型ストレージコンテナ)
      const hexMat = containerMats[2]!;
      const hexBody = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 8.8, 6), hexMat);
      hexBody.rotation.x = Math.PI / 2;
      cargo.add(hexBody);
      // 周状補強フランジ
      for (const zRing of [-3.0, 0, 3.0]) {
        const ring = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 0.4, 6), conduitJointMat);
        ring.position.set(0, 0, zRing);
        ring.rotation.x = Math.PI / 2;
        cargo.add(ring);
      }
    } else {
      // 8) Truss Frame Equipment Rack (オープン格子トラス＋アビオニクスキューブ)
      const w = 4.5, h = 4.5, d = 9.0;
      const trussFrameMat = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, flatShading: true, roughness: 0.25, metalness: 0.5 });
      const outerFrame = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), trussFrameMat);
      cargo.add(outerFrame);
      for (const zCube of [-2.0, 2.0]) {
        const avCube = new THREE.Mesh(new THREE.BoxGeometry(3.2, 3.2, 3.2), sensorPodMat);
        avCube.position.set(0, 0, zCube);
        cargo.add(avCube);
      }
    }
    return cargo;
  };

  // 決定論的疑似乱数ヘルパー (再現性のある不規則乱雑配置)
  const pseudoHash = (n: number): number => {
    const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
  };

  // 【貨物量半分(100個) & 角度揃え(0,0,0)の乱雑・不規則配置】
  let cIdx = 0;
  for (let zStep = 0; zStep < 20; zStep++) {
    const zBase = cwCenterZ - 30 + zStep * 3.3;
    for (const quadX of [-1, 1]) {
      for (const quadY of [-1, 1]) {
        // スロットごとの不規則な空き・虫食い配置 (乱雑さの創出)
        const randSeed = zStep * 100 + (quadX > 0 ? 10 : 0) + (quadY > 0 ? 1 : 0);
        if (pseudoHash(randSeed) < 0.45) continue; // 45%の確率で空きスロット

        // スタック高さの不規則なバラつき (1〜4段)
        const stackLimit = 1 + Math.floor(pseudoHash(randSeed * 1.5) * 3.8);

        for (let layer = 0; layer < stackLimit; layer++) {
          // 微小なZ軸スライド・段差オフセット (角度は0,0,0のまま位置だけ乱雑に散らす)
          const zOffset = (pseudoHash(randSeed + layer * 7) - 0.5) * 2.6;
          const posX = quadX * (9.5 + layer * 4.6);
          const posY = quadY * (9.5 + layer * 4.6);

          const mat = containerMats[cIdx % containerMats.length]!;
          const tagMat = cIdx % 4 === 0 ? (cIdx % 8 === 0 ? neonAccentMat : hazardOrangeMat) : undefined;

          const cargoObj = buildAdvancedCargoGroup(cIdx, mat, tagMat);
          cargoObj.position.set(posX, posY, zBase + zOffset);
          cargoObj.rotation.set(0, 0, 0); // 角度は完全に統一
          g.add(cargoObj);

          cIdx++;
          if (cIdx >= 100) break;
        }
        if (cIdx >= 100) break;
      }
      if (cIdx >= 100) break;
    }
    if (cIdx >= 100) break;
  }

  // 基地の全体サイズを 3倍 に変更
  g.scale.setScalar(3.0);

  markLitOpaque(g);
  return g;
}
