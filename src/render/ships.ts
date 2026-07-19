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
export const MAG_DEPTH = MAG_THICKNESS * 3; // 前後(Z)
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

// 破片: 塊・外板(パネル)・桁(ロッド)の 3 種をランダムに混ぜる。
// 撃破時の飛散と被弾時の欠片の両方で使う。
// 各テンプレートは size=1 の基準形状として焼き出されており、個体差(サイズ・
// 塊の不規則な歪み・パネル/ロッドの伸縮・暗色/アクセント色の別)は
// この関数がクローン後に scale とジオメトリ頂点・マテリアル色で都度付与する
// (旧実装では Math.random() で毎回ジオメトリを作り直していたのと同じ見た目になるよう、
// 塊(テトラヒドロン)は頂点ジッタを再現し、パネル/ロッドは非一様スケールで
// 元の乱数幅を再現する)。
export function buildDebrisMesh(accent: number, size: number): THREE.Mesh {
  const kind = Math.random();
  const dark = Math.random() < 0.6;
  const color = dark ? 0x3c4149 : accent;

  let mesh: THREE.Mesh;
  if (kind < 0.45) {
    // 不規則な低ポリ塊: クローンしたジオメトリ自体をジッタさせる(共有ジオメトリを汚さないよう複製必須)
    mesh = parseDebrisChunk();
    mesh.geometry = mesh.geometry.clone();
    const pos = mesh.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(
        i,
        pos.getX(i) * (0.6 + Math.random() * 0.9),
        pos.getY(i) * (0.6 + Math.random() * 0.9),
        pos.getZ(i) * (0.6 + Math.random() * 0.9),
      );
    }
    pos.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
    mesh.scale.setScalar(size);
  } else if (kind < 0.78) {
    // ちぎれた外板(タンブリングで表裏がチラつき、破片らしく見える)
    mesh = parseDebrisPanel();
    mesh.scale.set(size * (1.2 + Math.random() * 0.8), size * 0.1, size * (0.8 + Math.random() * 0.6));
  } else {
    // 折れた桁・配管
    mesh = parseDebrisRod();
    mesh.scale.set(size, size * (1.6 + Math.random()), size);
  }

  const mat = mesh.material as THREE.MeshStandardMaterial;
  mat.color.set(color);
  return mesh;
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
export function buildBarrelMesh(): THREE.Mesh {
  // 黒光りする金属質の円柱 (4倍サイズに変更)
  const geo = new THREE.CylinderGeometry(0.6, 0.6, 4.8, 8);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x222222,
    roughness: 0.3,
    metalness: 0.8,
  });
  const mesh = new THREE.Mesh(geo, mat);
  // 放出時は少し赤熱している表現を入れるとなお良い（ここではシンプルに金属色）
  return mesh;
}
