// リアル調の地球: 高解像度球 + 頂点ごとの滑らかな色(ノイズによる大陸・バイオーム生成)
// + スムーズシェーディング、加算合成の大気リムで構成する。実寸(半径 6371km)。
// テクスチャアセットは使わず、起動時に手続き的に頂点色を計算する。
import * as THREE from 'three/webgpu';
import { R_EARTH } from '../physics/orbital';

// 決定論的な 3D 値ノイズ (fBm)
function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const fz = smooth(z - iz);

  let result = 0;
  for (let dz = 0; dz <= 1; dz++) {
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const w =
          (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
        result += w * hash3(ix + dx, iy + dy, iz + dz);
      }
    }
  }
  return result;
}

function fbm(x: number, y: number, z: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * freq + 31.4, y * freq + 17.7, z * freq + 5.2);
    amp *= 0.5;
    freq *= 2.1;
  }
  return sum; // おおよそ [0, 1)
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

function smoothstep(a: number, b: number, t: number): number {
  return smooth(clamp01((t - a) / (b - a)));
}

const OCEAN_DEEP = new THREE.Color(0x08234f);
const OCEAN_MID = new THREE.Color(0x0d3a74);
const OCEAN_SHALLOW = new THREE.Color(0x1d6aa8);
const COAST_SAND = new THREE.Color(0xc9b982);
const LAND_GREEN = new THREE.Color(0x4d8a4a);
const LAND_FOREST = new THREE.Color(0x2a5c36);
const LAND_DESERT = new THREE.Color(0xc7a35f);
const LAND_TUNDRA = new THREE.Color(0x8f8f76);
const LAND_ROCK = new THREE.Color(0x7d766a);
const SNOW = new THREE.Color(0xf2f6fc);
const CLOUD_WHITE = new THREE.Color(0xf8fafd);
const tmpA = new THREE.Color();
const tmpB = new THREE.Color();

// 頂点位置(単位球)→ 色。閾値の段差を作らず smoothstep で連続的に混ぜて
// 実写調のグラデーションにする。雲は別シェルだと水平線付近で地表と
// z-fighting するため頂点色に焼き込む(LEO から高度16kmの視差はほぼ知覚できない)。
function vertexColor(px: number, py: number, pz: number, out: THREE.Color): void {
  const continents = fbm(px * 1.6, py * 1.6, pz * 1.6, 6);
  const detail = fbm(px * 5.0 + 9.1, py * 5.0, pz * 5.0, 5);
  const micro = fbm(px * 13.0 + 3.3, py * 13.0, pz * 13.0, 3);
  const lat = Math.abs(py); // 単位球なので |y| = sin(緯度)

  const landness = smoothstep(0.5, 0.535, continents); // 0=海, 1=陸

  // --- 海: 深海 → 沿岸のグラデーション + 微細な色むら ---
  const depth = smoothstep(0.3, 0.52, continents);
  tmpA.lerpColors(OCEAN_DEEP, OCEAN_MID, depth * 0.7 + micro * 0.15);
  tmpA.lerp(OCEAN_SHALLOW, smoothstep(0.47, 0.53, continents) * 0.8);

  // --- 陸: 高度・緯度・乾燥度でバイオームを連続的に混合 ---
  const elev = smoothstep(0.535, 0.75, continents) + (detail - 0.5) * 0.3; // 標高感
  const climate = clamp01(lat + (detail - 0.5) * 0.3); // 0=熱帯, 1=極
  const dryness = smoothstep(0.45, 0.65, fbm(px * 2.6 + 77.7, py * 2.6, pz * 2.6, 4));

  tmpB.lerpColors(LAND_GREEN, LAND_FOREST, smoothstep(0.15, 0.55, detail));
  // 低緯度の乾燥地帯は砂漠へ
  tmpB.lerp(LAND_DESERT, dryness * smoothstep(0.5, 0.15, climate));
  // 高緯度はツンドラ → 雪原へ
  tmpB.lerp(LAND_TUNDRA, smoothstep(0.6, 0.8, climate));
  tmpB.lerp(SNOW, smoothstep(0.8, 0.95, climate));
  // 高標高は岩肌、さらに高いと冠雪
  tmpB.lerp(LAND_ROCK, smoothstep(0.55, 0.85, elev) * 0.85);
  tmpB.lerp(SNOW, smoothstep(0.85, 1.05, elev + climate * 0.25));
  // 海岸線の砂浜(ごく狭い帯)
  tmpB.lerp(COAST_SAND, smoothstep(0.08, 0.0, landness - 0.08) * 0.5);

  out.lerpColors(tmpA, tmpB, landness);

  // 極冠(縁をノイズで揺らす)
  out.lerp(SNOW, smoothstep(0.94, 0.975, lat + (detail - 0.5) * 0.04));

  // 微細な明度むら(のっぺり感を防ぐ。面ジッタではなく連続ノイズ)
  out.multiplyScalar(0.94 + micro * 0.12);

  // 雲: 大小 2 スケールを合成し、縁を柔らかく
  const cloudBase = fbm(px * 2.3 + 51.7, py * 2.3, pz * 2.3, 5);
  const cloudWisp = fbm(px * 6.1 + 13.9, py * 6.1, pz * 6.1, 3);
  const cover = smoothstep(0.52, 0.72, cloudBase * 0.75 + cloudWisp * 0.25);
  out.lerp(CLOUD_WHITE, cover * 0.9);
}

function buildSurface(): THREE.Mesh {
  // インデックス付き球ジオメトリ + 頂点色 + スムーズシェーディング。
  // 512×384 分割で三角形は ~80km — LEO からは滑らかな球面に見える。
  const geo = new THREE.SphereGeometry(R_EARTH, 512, 384);
  const pos = geo.getAttribute('position');
  const count = pos.count;
  const colors = new Float32Array(count * 3);
  const c = new THREE.Color();

  for (let i = 0; i < count; i++) {
    vertexColor(pos.getX(i) / R_EARTH, pos.getY(i) / R_EARTH, pos.getZ(i) / R_EARTH, c);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.62, // 海面の太陽ハイライトがうっすら出る程度
    metalness: 0.05,
  });
  return new THREE.Mesh(geo, mat);
}

function buildAtmoShell(radius: number, color: number, opacity: number): THREE.Mesh {
  const geo = new THREE.SphereGeometry(radius, 48, 32);
  const mat = new THREE.MeshBasicMaterial({
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

export interface Earth {
  group: THREE.Group;
  setRotation(angleRad: number): void;
}

export function createEarth(): Earth {
  const group = new THREE.Group();
  const spin = new THREE.Group();
  spin.add(buildSurface());
  group.add(spin);
  // 大気のリム光: 加算合成の BackSide シェルは地球本体に隠されない
  // 縁の部分だけがリング状に見える
  group.add(buildAtmoShell(R_EARTH + 90e3, 0x4d9fff, 0.22));
  group.add(buildAtmoShell(R_EARTH + 170e3, 0x2a6bdd, 0.09));

  return {
    group,
    setRotation(angleRad: number) {
      spin.rotation.y = angleRad;
    },
  };
}
