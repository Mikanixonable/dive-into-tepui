// プリミティブ組み合わせによるローポリ機体・弾・薬莢・デブリのメッシュ生成。
// 機体の機首は +Z 方向。
// ジオメトリ/マテリアルの構築自体は tools/export-models.mjs に移し、
// src/assets/models/*.json として事前に焼き出したものを ObjectLoader で読み込む。
import * as THREE from 'three/webgpu';
import * as C from '../game/const';

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
import ammoData from '../assets/models/ammo.json';
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
const parseAmmo = memoParse<THREE.Group>(ammoData);
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

// 軌道上に投入される補給(ammo): マガジン数個を束ねてビーコンを付けた漂流物。
// テンプレートは既定の count=4 で焼き出し済み。count が既定と異なる場合は、
// マガジンサブメッシュを buildMagazineMesh() 経由で再利用しながら都度組み立てる。
let ammoBeaconGeom: THREE.OctahedronGeometry | null = null;
let ammoBeaconMat: THREE.MeshBasicMaterial | null = null;

// 軌道上補給物のメッシュを生成する。count はマガジン本数(既定 4 はテンプレートを再利用)。
export function buildAmmo(count = 4): THREE.Group {
  if (count === 4) return parseAmmo();
  const g = new THREE.Group();
  // マガジンを count 本、縦一列に並べる
  for (let i = 0; i < count; i++) {
    const mag = buildMagazineMesh();
    mag.position.y = (i - (count - 1) / 2) * (MAG_THICKNESS + 0.12);
    g.add(mag);
  }
  if (!ammoBeaconGeom) ammoBeaconGeom = new THREE.OctahedronGeometry(0.35, 0);
  if (!ammoBeaconMat) ammoBeaconMat = new THREE.MeshBasicMaterial({ color: 0x4de8ff });

  // 先端にビーコンを追加する
  const beacon = new THREE.Mesh(ammoBeaconGeom, ammoBeaconMat.clone());
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

// 薬莢メッシュを生成する。全長を通常の2倍にした geometry と銅色 material は共有する。
export function buildCasingMesh(): THREE.Mesh {
  initCasingResources();
  const mesh = new THREE.Mesh(casingGeometry!, casingMaterial!);
  // DebrisPiece.dispose() が共有リソースを解放しないよう、所有権を明示する。
  mesh.userData.ownsGeometry = false;
  mesh.userData.ownsMaterial = false;
  return mesh;
}

// 破片: 撃破時の飛散と被弾欠片に使う。style 引数で敵種別ごとの固有形状
// (mech/crystal/ring/spike/汎用)を生成し、アクセントカラーで敵機のテーマカラーを継承する。

type DebrisMaterial = (opts?: { roughness?: number; metalness?: number; flatShading?: boolean }) => THREE.MeshStandardMaterial;

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

// デブリ形状 'mech' のバリエーションをランダムに1つ生成する。
function buildMechDebris(size: number, mat: DebrisMaterial): THREE.Mesh {
  const kind = Math.floor(Math.random() * 4);
  if (kind === 0) {
    // T字断面の構造桁材: 垂直に交差する 2 本の矩形桁を結合(ここでは近似としてBoxで包んだGroup)
    const g2 = new THREE.Group();
    const m1 = withDispose(new THREE.Mesh(new THREE.BoxGeometry(0.12, 1, 0.12), mat({ roughness: 0.50, metalness: 0.60 })));
    g2.add(m1);
    const m2 = withDispose(new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.12, 0.12), mat({ roughness: 0.50, metalness: 0.60 })));
    m2.position.y = 0.40;
    g2.add(m2);
    const wrapper = withDispose(new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), mat()));
    wrapper.add(g2);
    wrapper.scale.setScalar(size);
    return wrapper;
  } else if (kind === 1) {
    // 歯車状(多角形に突起)
    const N = 6;
    const geo = new THREE.CylinderGeometry(1, 1, 0.20, N, 1, false);
    displaceVertices(geo, (x, y, z) => {
      const angle = Math.atan2(x, z);
      const nearToothAngle = Math.round(angle / (Math.PI * 2 / N)) * (Math.PI * 2 / N);
      const toothAmt = Math.cos((angle - nearToothAngle) * N / 2);
      const scale2 = 1 + Math.max(0, toothAmt) * 0.5;
      return [x * scale2, y, z * scale2];
    });
    const mesh = withDispose(new THREE.Mesh(geo, mat({ roughness: 0.45, metalness: 0.70 })));
    mesh.scale.setScalar(size);
    return mesh;
  } else if (kind === 2) {
    // 歪んだ外板
    const geo = new THREE.BoxGeometry(1, 0.08, 0.6);
    displaceVertices(geo, (x, y, z) => [x + (Math.random() - 0.5) * 0.2, y, z + (Math.random() - 0.5) * 0.15]);
    const mesh = withDispose(new THREE.Mesh(geo, mat({ roughness: 0.60, metalness: 0.55 })));
    mesh.scale.set(size * (1.2 + Math.random()), size * 0.9, size * (0.8 + Math.random() * 0.6));
    return mesh;
  } else {
    const geo = new THREE.TorusGeometry(0.5, 0.12, 4, 8, Math.PI * (0.6 + Math.random() * 1.2));
    const mesh = withDispose(new THREE.Mesh(geo, mat({ roughness: 0.40, metalness: 0.75 })));
    mesh.scale.setScalar(size);
    return mesh;
  }
}

// デブリ形状 'crystal' のバリエーションをランダムに1つ生成する。
function buildCrystalDebris(size: number, mat: DebrisMaterial): THREE.Mesh {
  const kind = Math.floor(Math.random() * 3);
  if (kind === 0) {
    // 柱状の結晶
    const profile = [
      new THREE.Vector2(0, -1), new THREE.Vector2(0.5, -0.5), new THREE.Vector2(0.55, 0),
      new THREE.Vector2(0.5, 0.5), new THREE.Vector2(0, 1),
    ];
    const geo = new THREE.LatheGeometry(profile, 6);
    const mesh = withDispose(new THREE.Mesh(geo, mat({ roughness: 0.20, metalness: 0.10 })));
    mesh.scale.set(size * (0.2 + Math.random() * 0.2), size * (0.6 + Math.random() * 0.6), size * (0.2 + Math.random() * 0.2));
    return mesh;
  } else if (kind === 1) {
    // 歪んだ八面体
    const geo = new THREE.OctahedronGeometry(1, 0);
    displaceVertices(geo, (x, y, z) => [x * (0.6 + Math.random() * 0.8), y * (0.7 + Math.random() * 0.6), z * (0.6 + Math.random() * 0.8)]);
    const mesh = withDispose(new THREE.Mesh(geo, mat({ roughness: 0.15, metalness: 0.10 })));
    mesh.scale.setScalar(size);
    return mesh;
  } else {
    // 円錐状の結晶片
    const geo = new THREE.CylinderGeometry(0.8, 0, 0.3, 5);
    displaceVertices(geo, (x, y, z) => [x * (0.8 + Math.random() * 0.6), y * (0.8 + Math.random() * 0.6), z * 1.5]);
    const mesh = withDispose(new THREE.Mesh(geo, mat({ roughness: 0.25, metalness: 0.10 })));
    mesh.scale.setScalar(size);
    return mesh;
  }
}

// デブリ形状 'ring' のバリエーションをランダムに1つ生成する。
function buildRingDebris(size: number, mat: DebrisMaterial): THREE.Mesh {
  const kind = Math.floor(Math.random() * 3);
  if (kind === 0) {
    // 円弧状のリング
    const arc = Math.PI * (0.4 + Math.random() * 1.2);
    const geo = new THREE.TorusGeometry(1, 0.18, 4, 10, arc);
    const mesh = withDispose(new THREE.Mesh(geo, mat({ roughness: 0.50, metalness: 0.60 })));
    mesh.scale.setScalar(size);
    return mesh;
  } else if (kind === 1) {
    // 歪んだ円盤
    const geo = new THREE.CylinderGeometry(1, 1, 0.08, 8, 1);
    displaceVertices(geo, (x, y, z) => [x + (Math.random() - 0.5) * 0.25, y, z + (Math.random() - 0.5) * 0.25]);
    const mesh = withDispose(new THREE.Mesh(geo, mat({ roughness: 0.45, metalness: 0.65 })));
    mesh.scale.set(size * (0.8 + Math.random() * 0.6), size * 0.6, size * (0.8 + Math.random() * 0.6));
    return mesh;
  } else {
    // 筒状のバンド
    const geo = new THREE.CylinderGeometry(0.7, 0.7, 0.40, 8, 1, true);
    const mesh = withDispose(new THREE.Mesh(geo, mat({ roughness: 0.40, metalness: 0.70, flatShading: false })));
    mesh.scale.setScalar(size);
    return mesh;
  }
}

// デブリ形状 'spike' のバリエーションをランダムに1つ生成する。
function buildSpikeDebris(size: number, mat: DebrisMaterial): THREE.Mesh {
  const kind = Math.floor(Math.random() * 3);
  if (kind === 0) {
    // 円錐状の棘
    const geo = new THREE.ConeGeometry(0.35, 1 + Math.random() * 0.8, 5, 1);
    const mesh = withDispose(new THREE.Mesh(geo, mat({ roughness: 0.30, metalness: 0.55 })));
    mesh.scale.set(size, size * (1.5 + Math.random()), size);
    return mesh;
  } else if (kind === 1) {
    // 歪んだ筒
    const geo = new THREE.CylinderGeometry(0.2, 0.8, 1, 4);
    displaceVertices(geo, (x, y, z) => [x * (0.5 + Math.random() * 0.8), y, z * (0.5 + Math.random() * 0.8)]);
    const mesh = withDispose(new THREE.Mesh(geo, mat({ roughness: 0.35, metalness: 0.50 })));
    mesh.scale.setScalar(size);
    return mesh;
  } else {
    // 細長い針
    const geo = new THREE.CylinderGeometry(0.08, 0.02, 1, 5, 1);
    const mesh = withDispose(new THREE.Mesh(geo, mat({ roughness: 0.35, metalness: 0.50 })));
    mesh.scale.set(size * 0.8, size * (3.0 + Math.random() * 2.0), size * 0.8);
    return mesh;
  }
}

// 汎用デブリ形状をランダムに1つ生成する。color は非破片(dark)判定込みの表示色。
function buildGenericDebris(color: string | number, size: number, mat: DebrisMaterial): THREE.Mesh {
  const kind = Math.random();
  if (kind < 0.22) {
    // 破損した外殻チャンク
    const mesh = parseDebrisChunk();
    // テンプレートの頂点バッファを共有したまま displaceVertices で書き換えると他インスタンスへ波及するため deep clone する
    mesh.geometry = deepCloneGeometry(mesh.geometry);
    mesh.userData.ownsGeometry = true;
    displaceVertices(mesh.geometry, (x, y, z) => [x * (0.5 + Math.random() * 1.2), y * (0.5 + Math.random() * 1.2), z * (0.4 + Math.random() * 1.6)]);
    mesh.scale.setScalar(size);
    (mesh.material as THREE.MeshStandardMaterial).color.set(color);
    return mesh;
  } else if (kind < 0.42) {
    // 平板パネル
    const mesh = parseDebrisPanel();
    mesh.scale.set(size * (1.5 + Math.random() * 1.2), size * (0.06 + Math.random() * 0.08), size * (0.7 + Math.random() * 0.8));
    (mesh.material as THREE.MeshStandardMaterial).color.set(color);
    return mesh;
  } else if (kind < 0.58) {
    // 構造ロッド
    const mesh = parseDebrisRod();
    mesh.scale.set(size * (0.8 + Math.random() * 0.4), size * (2.2 + Math.random() * 1.4), size * (0.8 + Math.random() * 0.4));
    (mesh.material as THREE.MeshStandardMaterial).color.set(color);
    return mesh;
  } else if (kind < 0.72) {
    // 歪んだ八面体
    const geo = new THREE.OctahedronGeometry(1, 0);
    displaceVertices(geo, (x, y, z) => [x * (0.5 + Math.random() * 1.0), y * (0.5 + Math.random() * 1.0), z * (0.7 + Math.random() * 0.9)]);
    const mesh = withDispose(new THREE.Mesh(geo, mat()));
    mesh.scale.setScalar(size);
    return mesh;
  } else if (kind < 0.86) {
    // 薄い歪んだ板
    const geo = new THREE.BoxGeometry(1, 1, 1);
    displaceVertices(geo, (x, y, z) => [x + (Math.random() - 0.5) * 0.35, y + (Math.random() - 0.5) * 0.35, z * 0.12]);
    const mesh = withDispose(new THREE.Mesh(geo, mat({ roughness: 0.70, metalness: 0.35 })));
    mesh.scale.set(size * (1.2 + Math.random() * 1.0), size * (1.2 + Math.random() * 1.0), size * 0.12);
    return mesh;
  } else {
    // 細い棒材
    const geo = new THREE.BoxGeometry(0.15, 1, 0.15);
    const mesh = withDispose(new THREE.Mesh(geo, mat({ roughness: 0.55, metalness: 0.55 })));
    mesh.scale.set(size * (0.8 + Math.random() * 0.4), size * (2.0 + Math.random() * 1.6), size * (0.8 + Math.random() * 0.4));
    return mesh;
  }
}

// style に応じたデブリメッシュを1つ生成する(未指定時は汎用形状)。
export function buildDebrisMesh(accent: string | number, size: number, style?: string): THREE.Mesh {
  const dark = Math.random() < 0.30;
  const color = dark ? C.COLOR_SHIP_DARK_HULL : accent;

  const mat: DebrisMaterial = (opts) =>
    new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.65, metalness: 0.30, ...opts });

  if (style === 'mech') return buildMechDebris(size, mat);
  if (style === 'crystal') return buildCrystalDebris(size, mat);
  if (style === 'ring') return buildRingDebris(size, mat);
  if (style === 'spike') return buildSpikeDebris(size, mat);
  // default: 汎用形状(複雑化)
  return buildGenericDebris(color, size, mat);
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
  return withDispose(new THREE.Mesh(geo, mat));
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
  return g;
}

// 基地: 中央ハブ + 放射状トラス4本 + ドッキングモジュール4基 + 太陽電池パドル2枚の低ポリ構成。
// game-entity/base.ts の radius(100m)と釣り合う全幅を持つ。
export function buildBaseModel(): THREE.Group {
  const g = new THREE.Group();
  const hullMat = new THREE.MeshStandardMaterial({ color: 0x2a2f38, flatShading: true, roughness: 0.45, metalness: 0.75 });
  const trussMat = new THREE.MeshStandardMaterial({ color: 0x1c2028, flatShading: true, roughness: 0.55, metalness: 0.65 });
  const panelMat = new THREE.MeshStandardMaterial({ color: 0x1a3a5c, flatShading: true, roughness: 0.35, metalness: 0.55 });
  const beaconMat = new THREE.MeshStandardMaterial({ color: 0xff6a00, emissive: 0xff6a00, emissiveIntensity: 1.2, roughness: 0.4 });

  const hub = new THREE.Mesh(new THREE.CylinderGeometry(18, 18, 60, 8), hullMat);
  g.add(hub);

  const trussLength = 70;
  const moduleOffset = 18 + trussLength;
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2;
    const dir = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));

    const truss = new THREE.Mesh(new THREE.BoxGeometry(trussLength, 4, 4), trussMat);
    truss.position.copy(dir).multiplyScalar(18 + trussLength / 2);
    truss.rotation.y = -angle;
    g.add(truss);

    const module = new THREE.Mesh(new THREE.CylinderGeometry(10, 10, 26, 8), hullMat);
    module.position.copy(dir).multiplyScalar(moduleOffset);
    module.rotation.z = Math.PI / 2;
    module.rotation.y = -angle;
    g.add(module);
  }

  for (const side of [1, -1]) {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(60, 1.5, 22), panelMat);
    panel.position.set(side * (18 + 34), 0, 0);
    g.add(panel);
  }

  const beacon = new THREE.Mesh(new THREE.SphereGeometry(3, 8, 6), beaconMat);
  beacon.position.set(0, 30, 0);
  g.add(beacon);

  return g;
}
