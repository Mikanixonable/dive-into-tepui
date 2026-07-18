// プリミティブ組み合わせによるローポリ機体・弾・薬莢・デブリのメッシュ生成。
// 機体の機首は +Z 方向。
// ジオメトリ/マテリアルの構築自体は tools/export-models.mjs に移し、
// src/assets/models/*.json として事前に焼き出したものを ObjectLoader で読み込む
// (buildFlashMesh は実行時キャンバステクスチャに依存するため従来どおり手続き的)。
import * as THREE from 'three/webgpu';

import playerData from '../assets/models/player.json';
import enemyData from '../assets/models/enemy.json';
import magazineData from '../assets/models/magazine.json';
import magPickupData from '../assets/models/magPickup.json';
import bulletData from '../assets/models/bullet.json';
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
const parseMagazine = memoParse<THREE.Group>(magazineData);
const parseMagPickup = memoParse<THREE.Group>(magPickupData);
const parseBullet = memoParse<THREE.Mesh>(bulletData);
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

export function buildBulletMesh(): THREE.Mesh {
  const m = parseBullet();
  m.frustumCulled = false;
  return m;
}

export function buildCasingMesh(): THREE.Mesh {
  return parseCasing();
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
