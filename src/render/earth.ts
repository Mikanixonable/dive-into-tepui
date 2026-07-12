// ローポリ地球: 面ごとの頂点色(ノイズによる大陸生成)+ フラットシェーディング、
// 雲シェル、加算合成の大気リムで構成する。実寸(半径 6371km)。
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

const OCEAN_DEEP = new THREE.Color(0x0a2f66);
const OCEAN_SHALLOW = new THREE.Color(0x155a96);
const LAND_GREEN = new THREE.Color(0x3f8f4d);
const LAND_FOREST = new THREE.Color(0x2c6b3f);
const LAND_DESERT = new THREE.Color(0xc9aa60);
const LAND_ROCK = new THREE.Color(0x8d8577);
const SNOW = new THREE.Color(0xeef3fa);
const CLOUD_WHITE = new THREE.Color(0xf6f9fd);

function faceColor(px: number, py: number, pz: number, out: THREE.Color): void {
  const continents = fbm(px * 1.6, py * 1.6, pz * 1.6, 5);
  const detail = fbm(px * 5.0 + 9.1, py * 5.0, pz * 5.0, 4);
  const lat = Math.abs(py); // 単位球なので |y| = sin(緯度)

  const iceEdge = 0.955 + (detail - 0.5) * 0.06;
  if (lat > iceEdge) {
    out.copy(SNOW);
  } else if (continents > 0.52) {
    // 陸地: 緯度と細部ノイズでバイオームを変える
    const t = lat + (detail - 0.5) * 0.35;
    if (continents > 0.62 && detail > 0.55) {
      out.copy(LAND_ROCK);
    } else if (t < 0.28 && detail > 0.48) {
      out.copy(LAND_DESERT);
    } else if (t > 0.72) {
      out.lerpColors(LAND_FOREST, SNOW, (t - 0.72) / 0.28);
    } else {
      out.lerpColors(LAND_GREEN, LAND_FOREST, detail);
    }
  } else {
    // 海: 大陸縁で浅くなる
    const shore = Math.max(0, (continents - 0.40) / 0.12);
    out.lerpColors(OCEAN_DEEP, OCEAN_SHALLOW, shore * 0.9 + detail * 0.1);
  }
  // 面ごとの明度ジッタでローポリ感を強調(隣接面の融合を防ぐ)
  const jitter = 0.9 + hash3(px * 91, py * 87, pz * 83) * 0.17;
  out.multiplyScalar(jitter);

  // 雲: 別シェルだと水平線付近で地表と z-fighting するため面色に焼き込む
  // (LEO からは高度16kmの視差はほぼ知覚できない)
  const cloud = fbm(px * 2.3 + 51.7, py * 2.3, pz * 2.3, 4);
  if (cloud > 0.57) {
    const t = Math.min(0.88, ((cloud - 0.57) / 0.18) * 0.88);
    out.lerp(CLOUD_WHITE, t);
  }
}

function buildSurface(): THREE.Mesh {
  // PolyhedronGeometry は非インデックスで頂点が面ごとに複製されるため、
  // 3頂点まとめて同色を書けば面単位の色になる。
  const geo = new THREE.IcosahedronGeometry(R_EARTH, 6);
  const pos = geo.getAttribute('position');
  const count = pos.count;
  const colors = new Float32Array(count * 3);
  const c = new THREE.Color();

  for (let f = 0; f < count / 3; f++) {
    const i0 = f * 3;
    const cx = (pos.getX(i0) + pos.getX(i0 + 1) + pos.getX(i0 + 2)) / 3 / R_EARTH;
    const cy = (pos.getY(i0) + pos.getY(i0 + 1) + pos.getY(i0 + 2)) / 3 / R_EARTH;
    const cz = (pos.getZ(i0) + pos.getZ(i0 + 1) + pos.getZ(i0 + 2)) / 3 / R_EARTH;
    faceColor(cx, cy, cz, c);
    for (let k = 0; k < 3; k++) {
      colors[(i0 + k) * 3] = c.r;
      colors[(i0 + k) * 3 + 1] = c.g;
      colors[(i0 + k) * 3 + 2] = c.b;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.95,
    metalness: 0,
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
