// リアル調の地球: 高解像度球 + 実在の地球のテクスチャ
// + 加算合成の大気リムで構成する。実寸(半径 6371km)。
// テクスチャは実在の地球の写真 (src/assets/earth.jpg) を使用。
import * as THREE from 'three/webgpu';
import { texture as textureNode, mix, uv, vec2, vec3 } from 'three/tsl';
import { R_EARTH } from '../physics/orbital';
import earthTextureUrl from '../assets/earth.jpg';
import cloudsTextureUrl from '../assets/8k_clouds.jpg';

// 地表 + 雲を単一の不透明メッシュとして合成する。雲を別シェル(地表+12km)で
// 重ねると、near=2m の 24bit 深度バッファでは水平線近くで両者の深度差が
// 1ulp 未満になり z-fighting でちらつく(このプロジェクトが実寸フローティング
// オリジン+非対数深度を選んでいる以上、深度分解能は距離の2乗で落ちるため
// シェル同士の間隔をどれだけ広げても解決しない)。雲はアルベド段階で
// 地表テクスチャに焼き合成し、深度上は地球を1枚のサーフェスにする。
function buildSurface(): THREE.Mesh {
  // インデックス付き球ジオメトリ + スムーズシェーディング。
  // 512×384 分割で三角形は ~80km — LEO からは滑らかな球面に見える。
  const geo = new THREE.SphereGeometry(R_EARTH, 512, 384);

  const earthMap = new THREE.TextureLoader().load(earthTextureUrl);
  earthMap.colorSpace = THREE.SRGBColorSpace;
  const cloudsMap = new THREE.TextureLoader().load(cloudsTextureUrl);

  const mat = new THREE.MeshStandardNodeMaterial({
    roughness: 0.62, // 海面の太陽ハイライトがうっすら出る程度
    metalness: 0.05,
  });
  const earthSample = textureNode(earthMap, uv());
  const cloudAlpha = textureNode(cloudsMap, uv().add(vec2(0.0008, 0))).r; // わずかに東へオフセットし雲の陰を表現
  mat.colorNode = mix(earthSample, vec3(1, 1, 1), cloudAlpha);
  return new THREE.Mesh(geo, mat as unknown as THREE.Material);
}

// 地平線のリム光用 BackSide シェル。Lambert 照明にすることで夜側では
// 太陽光と一緒に暗くなる(Basic だと夜側でも光ってしまい、縞に見える)。
function buildAtmoShell(radius: number, color: number, opacity: number): THREE.Mesh {
  const geo = new THREE.SphereGeometry(radius, 64, 48);
  const mat = new THREE.MeshLambertMaterial({
    color,
    transparent: true,
    opacity,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 2;
  return mesh;
}

// 太陽光で照らされる加算シェル。Lambert の減光がそのまま昼夜の
// ターミネーターをまたぐ「薄明のグラデーション」になる。
function buildLitAtmoShell(radius: number, color: number, opacity: number): THREE.Mesh {
  const geo = new THREE.SphereGeometry(radius, 96, 64);
  const mat = new THREE.MeshLambertMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 2;
  return mesh;
}

// オーロラカーテン: 磁気(≒地理)極を囲む緯度 ~67° の波打つリング帯。
// 下端は緑、上端はほぼ黒(加算合成なので黒 = 透明)へフェードする紫。
function buildAurora(sign: 1 | -1, seed: number): THREE.Mesh {
  const SEG = 160;
  const positions = new Float32Array((SEG + 1) * 2 * 3);
  const colors = new Float32Array((SEG + 1) * 2 * 3);
  const indices: number[] = [];

  for (let i = 0; i <= SEG; i++) {
    const th = (i / SEG) * Math.PI * 2;
    // 緯度・高さをノイズ的に波打たせる(閉ループになるよう周期関数のみ)
    const latDeg =
      66 + 4.5 * Math.sin(3 * th + seed) + 2.2 * Math.sin(7 * th + seed * 2.3) + 1.1 * Math.sin(13 * th);
    const lat = ((latDeg * Math.PI) / 180) * sign;
    const hTop = 240e3 + 90e3 * Math.sin(2 * th + seed * 1.7) + 40e3 * Math.sin(5 * th);
    const cl = Math.cos(lat);
    const dirX = cl * Math.cos(th);
    const dirY = Math.sin(lat);
    const dirZ = cl * Math.sin(th);
    const rBot = R_EARTH + 95e3;
    const rTop = R_EARTH + 95e3 + hTop;
    const iBot = i * 2 * 3;
    positions.set([dirX * rBot, dirY * rBot, dirZ * rBot], iBot);
    positions.set([dirX * rTop, dirY * rTop, dirZ * rTop], iBot + 3);
    const flick = 0.75 + 0.25 * Math.sin(9 * th + seed * 3.1);
    colors.set([0.1 * flick, 0.85 * flick, 0.45 * flick], iBot); // 下端: 緑
    colors.set([0.1, 0.03, 0.14], iBot + 3); // 上端: ほぼ黒に落ちる紫
    if (i < SEG) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(indices);
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 3;
  return mesh;
}

export interface Earth {
  group: THREE.Group;
  setRotation(angleRad: number): void;
  tick(dt: number): void; // オーロラの明滅アニメーション
}

export function createEarth(): Earth {
  const group = new THREE.Group();
  const spin = new THREE.Group();
  spin.add(buildSurface());

  // オーロラは磁気極に固定なので自転と一緒に回す
  const auroras = [buildAurora(1, 1.3), buildAurora(-1, 4.1)];
  for (const a of auroras) spin.add(a);
  group.add(spin);

  // 連続な濃度の大気: 指数減衰する薄い発光シェルを多数重ね、離散的な
  // 「縞」が見えない滑らかなグラデーションにする。高度方向は二乗分布で
  // 低高度ほど密にシェルを置き、不透明度はスケールハイト ~100km の指数則。
  // Lambert 照明なので昼側だけ青く光り、ターミネーターに薄明のグラデーションが出る。
  // 最大高度は通常の飛行高度(420km)より低くし、カメラがシェル内に入らないようにする。
  const SHELLS = 16;
  for (let i = 0; i < SHELLS; i++) {
    const t = i / (SHELLS - 1);
    const h = 10e3 + 330e3 * t * t;
    const op = 0.052 * Math.exp(-h / 100e3) + 0.0035;
    group.add(buildLitAtmoShell(R_EARTH + h, 0x5d9fe8, op));
  }

  // 大気のリム光: 加算合成の BackSide シェルは地球本体に隠されず、
  // 縁の部分だけがリング状に見える。こちらも多層化して指数的に減衰させ、
  // 単発の輪ではなく外側へ溶けるグラデーションにする。
  const RIMS = 8;
  for (let i = 0; i < RIMS; i++) {
    const t = i / (RIMS - 1);
    const h = 40e3 + 280e3 * t * t;
    const op = 0.075 * Math.exp(-h / 90e3) + 0.004;
    group.add(buildAtmoShell(R_EARTH + h, 0x4d9fff, op));
  }

  let auroraPhase = 0;
  return {
    group,
    setRotation(angleRad: number) {
      spin.rotation.y = angleRad;
    },
    tick(dt: number) {
      // ゆっくりした明滅(実時間ベース)
      auroraPhase += dt;
      for (let i = 0; i < auroras.length; i++) {
        const m = auroras[i]!.material as THREE.MeshBasicMaterial;
        m.opacity = 0.45 + 0.2 * Math.sin(auroraPhase * 0.7 + i * 2.1) * Math.sin(auroraPhase * 0.23 + i);
      }
    },
  };
}
