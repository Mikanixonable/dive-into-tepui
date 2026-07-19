// プリミティブ組み合わせによるローポリ機体・弾・薬莢・デブリのメッシュ生成。
// 機体の機首は +Z 方向。
// ジオメトリ/マテリアルの構築自体は tools/export-models.mjs に移し、
// src/assets/models/*.json として事前に焼き出したものを ObjectLoader で読み込む
// (buildFlashMesh は実行時キャンバステクスチャに依存するため従来どおり手続き的)。
import * as THREE from 'three/webgpu';

import playerData from '../assets/models/player.json';
import enemyData from '../assets/models/enemy.json';
import stage0EnemyDataA from '../assets/models/stage0EnemyA.json';
import stage0EnemyDataB from '../assets/models/stage0EnemyB.json';
import stage0EnemyDataC from '../assets/models/stage0EnemyC.json';
import magazineData from '../assets/models/magazine.json';
import magPickupData from '../assets/models/magPickup.json';
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

// RCS スラスタブロックの機体座標(噴射パフの表示位置と一致させるためエクスポート)
export const RCS_BLOCK_OFFSETS: { x: number; y: number; z: number }[] = [
  { x: 1.0, y: 0.85, z: 1.9 },
  { x: -1.0, y: 0.85, z: 1.9 },
  { x: 1.0, y: -0.85, z: 1.9 },
  { x: -1.0, y: -0.85, z: 1.9 },
];

// マガジン寸法(機体座標系)。ベルト連結間隔(MAG_BELT_PITCH)は game.ts が
// マガジンリンクの並びを計算するのに使う。純粋な数値なので JSON 化はしない。
export const MAG_THICKNESS = 1.0;
export const MAG_WIDTH = MAG_THICKNESS * 4; // ベルト方向(X)
export const MAG_BELT_PITCH = MAG_WIDTH + 0.18; // 連結間隔

const loader = new THREE.ObjectLoader();

// クローン時、THREE の Object3D.clone(true) は同じ parse から得た
// マテリアル/ジオメトリを参照共有する。呼び出し側が個体ごとに
// material の色や opacity を書き換える(マズルフラッシュ等)場合があるため、
// そうした用途のテンプレートは clone のたびに traverse してマテリアルを
// 複製し直す。ここで扱うテンプレート自体は opacity 等を実行時に書き換えない
// ものばかりだが、将来の変更に備えて一律で安全側(非共有)にしておく。
function cloneIndependent<T extends THREE.Object3D>(template: T): T {
  const clone = template.clone(true) as T;
  clone.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((m) => m.clone());
    } else if (mesh.material) {
      mesh.material = (mesh.material as THREE.Material).clone();
    }
  });
  return clone;
}

function memoParse<T extends THREE.Object3D>(data: object): () => T {
  let cached: T | null = null;
  return () => {
    if (!cached) cached = loader.parse(data) as T;
    return cloneIndependent(cached);
  };
}

const parsePlayer = memoParse<THREE.Group>(playerData);
const parseEnemy = memoParse<THREE.Group>(enemyData);
const parseStage0EnemyA = memoParse<THREE.Group>(stage0EnemyDataA);
const parseStage0EnemyB = memoParse<THREE.Group>(stage0EnemyDataB);
const parseStage0EnemyC = memoParse<THREE.Group>(stage0EnemyDataC);
const parseMagazine = memoParse<THREE.Group>(magazineData);
const parseMagPickup = memoParse<THREE.Group>(magPickupData);
const parseBullet = memoParse<THREE.Mesh>(bulletData);
const parsePlasma = memoParse<THREE.Mesh>(plasmaData);
const parseCasing = memoParse<THREE.Mesh>(casingData);
const parseDebrisChunk = memoParse<THREE.Mesh>(debrisChunkData);
const parseDebrisPanel = memoParse<THREE.Mesh>(debrisPanelData);
const parseDebrisRod = memoParse<THREE.Mesh>(debrisRodData);

export function buildPlayerShip(): THREE.Group {
  return parsePlayer();
}

export function buildMagazineMesh(): THREE.Group {
  return parseMagazine();
}

// 弾を抜いた「空」のマガジン(外枠のみ)。給弾機構内で既に発射済みの弾を
// 保持しているマガジンは見た目上「空」であるべきなので、ここで弾(role==='round'
// が付いた丸・弾頭メッシュ)を除去したフレームだけの版を作る。
// 右舷排出口の常設表示・排出デブリの両方で使う。
export function buildMagazineFrame(): THREE.Group {
  const g = parseMagazine();
  for (const child of [...g.children]) {
    if ((child as THREE.Mesh).userData?.['role'] === 'round') g.remove(child);
  }
  return g;
}

// 軌道上に投入される補給マガジン: マガジン数個を束ねてビーコンを付けた漂流物。
// テンプレートは既定の count=4 で焼き出し済み。他の個数の呼び出しは現状ないが、
// 念のため count が既定と異なる場合は都度組み立てる(マガジンサブメッシュは
// buildMagazineMesh() 経由でテンプレートを再利用する)。
export function buildMagPickup(count = 4): THREE.Group {
  if (count === 4) return parseMagPickup();
  const g = new THREE.Group();
  for (let i = 0; i < count; i++) {
    const mag = buildMagazineMesh();
    mag.position.y = (i - (count - 1) / 2) * (MAG_THICKNESS + 0.12);
    g.add(mag);
  }
  const beacon = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.35, 0),
    new THREE.MeshBasicMaterial({ color: 0x4de8ff }),
  );
  beacon.position.y = (count / 2) * (MAG_THICKNESS + 0.12) + 0.4;
  g.add(beacon);
  return g;
}

// 敵機: テンプレートはプレースホルダの基本色で焼き出されている。
// フィン(finMat)とランプ(lampMat)は userData.role === 'accent' が付与されて
// おり、これを目印にアクセントカラーへ塗り替える。
export function buildEnemyShip(accent = 0xff4a3d): THREE.Group {
  const g = parseEnemy();
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

export function buildStage0EnemyShip(accent = 0x3dc6ff, typeIndex = 0): THREE.Group {
  let g: THREE.Group;
  if (typeIndex === 1) g = parseStage0EnemyB();
  else if (typeIndex === 2) g = parseStage0EnemyC();
  else g = parseStage0EnemyA();
  
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

export function buildBulletMesh(): THREE.Group {
  const m = parseBullet();
  m.frustumCulled = false;

  // 敵のプラズマ弾と同様、自機の弾丸にも光芒(半透明の加算合成ハロー)を付ける
  const haloMat = new THREE.MeshBasicMaterial({
    color: 0xffc86e,
    transparent: true,
    opacity: 0.35,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const haloGeom = new THREE.CylinderGeometry(0.5, 0.5, 7, 8);
  haloGeom.rotateX(Math.PI / 2); // 進行方向(Z軸)に合わせる
  const halo = new THREE.Mesh(haloGeom, haloMat);

  const g = new THREE.Group();
  g.add(m);
  g.add(halo);
  return g;
}

let plasmaGeomFixed = false;

export function buildPlasmaMesh(accent = 0xffa0ff): THREE.Group {
  const m = parsePlasma();
  if (!plasmaGeomFixed) {
    // plasma.json (CylinderGeometry) は toJSON() がコンストラクタ引数のみを保存する
    // 仕様のため、export-models.mjs 側で焼き込んだ rotateX() 補正がロード時に失われ、
    // 円柱の長さ軸が既定の Y のままになる(下の halo は毎回ランタイムで rotateX() し
    // ているので正しく Z 軸に揃う)。memoParse は geometry を clone しないため全インス
    // タンスがこの共有ジオメトリを参照する。一度だけ補正を掛け直す(毎回だと累積回転
    // してしまう)。
    m.geometry.rotateX(Math.PI / 2);
    plasmaGeomFixed = true;
  }
  const mat = m.material as THREE.MeshBasicMaterial;
  mat.color.set(accent);
  mat.blending = THREE.AdditiveBlending;
  m.frustumCulled = false;
  
  // スケールを大きくして視認性を上げる
  m.scale.set(1.5, 1.5, 1.5);
  
  // 弾の発光は弾本体と同じく円柱状にして
  const haloMat = new THREE.MeshBasicMaterial({
    color: accent,
    transparent: true,
    opacity: 0.35,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const haloGeom = new THREE.CylinderGeometry(1.5, 1.5, 16, 8);
  haloGeom.rotateX(Math.PI / 2); // 進行方向(Z軸)に合わせる
  const halo = new THREE.Mesh(haloGeom, haloMat);
  
  const g = new THREE.Group();
  g.add(m);
  g.add(halo);
  return g;
}

export function buildCasingMesh(): THREE.Mesh {
  const mesh = parseCasing();
  // 薬莢の全長(Y軸)を2倍にする
  mesh.geometry = mesh.geometry.clone();
  mesh.geometry.scale(1, 2, 1);
  return mesh;
}

// 破片: 撃破時の飛散と被弾欠片に使う。
// 形状を 6 種類に増やし、アクセントカラーを積極的に使用して
// 敵機のテーマカラーを継承させる。
// style 引数によって敵種別の固有形状を生成する。

type DebrisMaterial = (opts?: { roughness?: number; metalness?: number; flatShading?: boolean }) => THREE.MeshStandardMaterial;

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

function buildMechDebris(size: number, mat: DebrisMaterial): THREE.Mesh {
  const kind = Math.floor(Math.random() * 4);
  if (kind === 0) {
    // T字断面の構造桁材: 垂直に交差する 2 本の矩形桁を結合(ここでは近似としてBoxで包んだGroup)
    const g2 = new THREE.Group();
    const m1 = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1, 0.12), mat({ roughness: 0.50, metalness: 0.60 }));
    g2.add(m1);
    const m2 = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.12, 0.12), mat({ roughness: 0.50, metalness: 0.60 }));
    m2.position.y = 0.40;
    g2.add(m2);
    const wrapper = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), mat());
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
    const mesh = new THREE.Mesh(geo, mat({ roughness: 0.45, metalness: 0.70 }));
    mesh.scale.setScalar(size);
    return mesh;
  } else if (kind === 2) {
    // 歪んだ外板
    const geo = new THREE.BoxGeometry(1, 0.08, 0.6);
    displaceVertices(geo, (x, y, z) => [x + (Math.random() - 0.5) * 0.2, y, z + (Math.random() - 0.5) * 0.15]);
    const mesh = new THREE.Mesh(geo, mat({ roughness: 0.60, metalness: 0.55 }));
    mesh.scale.set(size * (1.2 + Math.random()), size * 0.9, size * (0.8 + Math.random() * 0.6));
    return mesh;
  } else {
    const geo = new THREE.TorusGeometry(0.5, 0.12, 4, 8, Math.PI * (0.6 + Math.random() * 1.2));
    const mesh = new THREE.Mesh(geo, mat({ roughness: 0.40, metalness: 0.75 }));
    mesh.scale.setScalar(size);
    return mesh;
  }
}

function buildCrystalDebris(size: number, mat: DebrisMaterial): THREE.Mesh {
  const kind = Math.floor(Math.random() * 3);
  if (kind === 0) {
    const profile = [
      new THREE.Vector2(0, -1), new THREE.Vector2(0.5, -0.5), new THREE.Vector2(0.55, 0),
      new THREE.Vector2(0.5, 0.5), new THREE.Vector2(0, 1),
    ];
    const geo = new THREE.LatheGeometry(profile, 6);
    const mesh = new THREE.Mesh(geo, mat({ roughness: 0.20, metalness: 0.10 }));
    mesh.scale.set(size * (0.2 + Math.random() * 0.2), size * (0.6 + Math.random() * 0.6), size * (0.2 + Math.random() * 0.2));
    return mesh;
  } else if (kind === 1) {
    const geo = new THREE.OctahedronGeometry(1, 0);
    displaceVertices(geo, (x, y, z) => [x * (0.6 + Math.random() * 0.8), y * (0.7 + Math.random() * 0.6), z * (0.6 + Math.random() * 0.8)]);
    const mesh = new THREE.Mesh(geo, mat({ roughness: 0.15, metalness: 0.10 }));
    mesh.scale.setScalar(size);
    return mesh;
  } else {
    const geo = new THREE.CylinderGeometry(0.8, 0, 0.3, 5);
    displaceVertices(geo, (x, y, z) => [x * (0.8 + Math.random() * 0.6), y * (0.8 + Math.random() * 0.6), z * 1.5]);
    const mesh = new THREE.Mesh(geo, mat({ roughness: 0.25, metalness: 0.10 }));
    mesh.scale.setScalar(size);
    return mesh;
  }
}

function buildRingDebris(size: number, mat: DebrisMaterial): THREE.Mesh {
  const kind = Math.floor(Math.random() * 3);
  if (kind === 0) {
    const arc = Math.PI * (0.4 + Math.random() * 1.2);
    const geo = new THREE.TorusGeometry(1, 0.18, 4, 10, arc);
    const mesh = new THREE.Mesh(geo, mat({ roughness: 0.50, metalness: 0.60 }));
    mesh.scale.setScalar(size);
    return mesh;
  } else if (kind === 1) {
    const geo = new THREE.CylinderGeometry(1, 1, 0.08, 8, 1);
    displaceVertices(geo, (x, y, z) => [x + (Math.random() - 0.5) * 0.25, y, z + (Math.random() - 0.5) * 0.25]);
    const mesh = new THREE.Mesh(geo, mat({ roughness: 0.45, metalness: 0.65 }));
    mesh.scale.set(size * (0.8 + Math.random() * 0.6), size * 0.6, size * (0.8 + Math.random() * 0.6));
    return mesh;
  } else {
    const geo = new THREE.CylinderGeometry(0.7, 0.7, 0.40, 8, 1, true);
    const mesh = new THREE.Mesh(geo, mat({ roughness: 0.40, metalness: 0.70, flatShading: false }));
    mesh.scale.setScalar(size);
    return mesh;
  }
}

function buildSpikeDebris(size: number, mat: DebrisMaterial): THREE.Mesh {
  const kind = Math.floor(Math.random() * 3);
  if (kind === 0) {
    const geo = new THREE.ConeGeometry(0.35, 1 + Math.random() * 0.8, 5, 1);
    const mesh = new THREE.Mesh(geo, mat({ roughness: 0.30, metalness: 0.55 }));
    mesh.scale.set(size, size * (1.5 + Math.random()), size);
    return mesh;
  } else if (kind === 1) {
    const geo = new THREE.CylinderGeometry(0.2, 0.8, 1, 4);
    displaceVertices(geo, (x, y, z) => [x * (0.5 + Math.random() * 0.8), y, z * (0.5 + Math.random() * 0.8)]);
    const mesh = new THREE.Mesh(geo, mat({ roughness: 0.35, metalness: 0.50 }));
    mesh.scale.setScalar(size);
    return mesh;
  } else {
    const geo = new THREE.CylinderGeometry(0.08, 0.02, 1, 5, 1);
    const mesh = new THREE.Mesh(geo, mat({ roughness: 0.35, metalness: 0.50 }));
    mesh.scale.set(size * 0.8, size * (3.0 + Math.random() * 2.0), size * 0.8);
    return mesh;
  }
}

function buildGenericDebris(color: number, size: number, mat: DebrisMaterial): THREE.Mesh {
  const kind = Math.random();
  if (kind < 0.22) {
    const mesh = parseDebrisChunk();
    mesh.geometry = mesh.geometry.clone();
    displaceVertices(mesh.geometry, (x, y, z) => [x * (0.5 + Math.random() * 1.2), y * (0.5 + Math.random() * 1.2), z * (0.4 + Math.random() * 1.6)]);
    mesh.scale.setScalar(size);
    (mesh.material as THREE.MeshStandardMaterial).color.set(color);
    return mesh;
  } else if (kind < 0.42) {
    const mesh = parseDebrisPanel();
    mesh.scale.set(size * (1.5 + Math.random() * 1.2), size * (0.06 + Math.random() * 0.08), size * (0.7 + Math.random() * 0.8));
    (mesh.material as THREE.MeshStandardMaterial).color.set(color);
    return mesh;
  } else if (kind < 0.58) {
    const mesh = parseDebrisRod();
    mesh.scale.set(size * (0.8 + Math.random() * 0.4), size * (2.2 + Math.random() * 1.4), size * (0.8 + Math.random() * 0.4));
    (mesh.material as THREE.MeshStandardMaterial).color.set(color);
    return mesh;
  } else if (kind < 0.72) {
    const geo = new THREE.OctahedronGeometry(1, 0);
    displaceVertices(geo, (x, y, z) => [x * (0.5 + Math.random() * 1.0), y * (0.5 + Math.random() * 1.0), z * (0.7 + Math.random() * 0.9)]);
    const mesh = new THREE.Mesh(geo, mat());
    mesh.scale.setScalar(size);
    return mesh;
  } else if (kind < 0.86) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    displaceVertices(geo, (x, y, z) => [x + (Math.random() - 0.5) * 0.35, y + (Math.random() - 0.5) * 0.35, z * 0.12]);
    const mesh = new THREE.Mesh(geo, mat({ roughness: 0.70, metalness: 0.35 }));
    mesh.scale.set(size * (1.2 + Math.random() * 1.0), size * (1.2 + Math.random() * 1.0), size * 0.12);
    return mesh;
  } else {
    const geo = new THREE.BoxGeometry(0.15, 1, 0.15);
    const mesh = new THREE.Mesh(geo, mat({ roughness: 0.55, metalness: 0.55 }));
    mesh.scale.set(size * (0.8 + Math.random() * 0.4), size * (2.0 + Math.random() * 1.6), size * (0.8 + Math.random() * 0.4));
    return mesh;
  }
}

export function buildDebrisMesh(accent: number, size: number, style?: string): THREE.Mesh {
  const dark = Math.random() < 0.30;
  const color = dark ? 0x2e3340 : accent;

  const mat: DebrisMaterial = (opts) =>
    new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.65, metalness: 0.30, ...opts });

  if (style === 'mech') return buildMechDebris(size, mat);
  if (style === 'crystal') return buildCrystalDebris(size, mat);
  if (style === 'ring') return buildRingDebris(size, mat);
  if (style === 'spike') return buildSpikeDebris(size, mat);
  // default: 汎用形状(複雑化)
  return buildGenericDebris(color, size, mat);
}


// カメラ方向を向く発光ビルボード(マズルフラッシュ・爆発)。
// キャンバステクスチャによる実行時グロー生成のため、これのみ従来どおり手続き的。
export function buildFlashMesh(texture: THREE.Texture, color: number): THREE.Mesh {
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    color,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  m.frustumCulled = false;
  m.renderOrder = 5;
  return m;
}

// リロード時に放出される砲身（バレル）メッシュ
// 砲身本体 + 後端フランジ + 放熱フィン + マズルブレーキ + 赤熱グロー + ガスポート
// 全径 ×0.7 でスリム化
export function buildBarrelMesh(): THREE.Group {
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

  return g;
}
