// 天体の見た目レジストリ: id から表示名と CelestialBody の生成関数を引く。
// 天体の日本語表示名の定義元はここ1箇所 — 他のモジュールは必ずここを読む。
import * as THREE from 'three/webgpu';
import { AttractorId, PlanetId, SatelliteId } from '../../physics/attractor';
import { bodyDef } from '../../physics/solar-system';
import { createMoon, MOON_VIS_DIST } from '../../render/stars';
import { CelestialBody } from './celestial-body';
import { EarthBody } from './earth-body';
import { SphereBody } from './sphere-body';
import { SunBody } from './sun-body';

import mercuryTextureUrl from '../../assets/2k_mercury.jpg';
import venusTextureUrl from '../../assets/2k_venus_atmosphere.jpg';
import marsTextureUrl from '../../assets/2k_mars.jpg';
import jupiterTextureUrl from '../../assets/2k_jupiter.jpg';
import saturnTextureUrl from '../../assets/2k_saturn.jpg';
import uranusTextureUrl from '../../assets/2k_uranus.jpg';
import neptuneTextureUrl from '../../assets/2k_neptune.jpg';

const PLANET_VIS_DIST = 5e7;

// テクスチャ付き半径 1 の球メッシュを組み立てて返す(Solar System Scope 提供の実写テクスチャ)。
function createTexturedSphereMesh(textureUrl: string): THREE.Mesh {
  const geo = new THREE.SphereGeometry(1, 48, 24);
  const texture = new THREE.TextureLoader().load(textureUrl);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshStandardMaterial({ map: texture, roughness: 1, metalness: 0 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

// テクスチャ付き惑星のレジストリ項を、表示名とテクスチャ URL から組む。
function planetEntry(id: PlanetId, name: string, textureUrl: string): { readonly name: string; create(): CelestialBody } {
  return { name, create: () => new SphereBody(id, () => createTexturedSphereMesh(textureUrl), bodyDef(id).radius, PLANET_VIS_DIST) };
}

// 単色の球メッシュを組み立てて返す(テクスチャを持たない天体の見た目)。
function createSolidSphereMesh(color: number): THREE.Mesh {
  const geo = new THREE.SphereGeometry(1, 32, 16);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 1, metalness: 0 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

// 単色の衛星のレジストリ項を、表示名と色から組む。表示距離は月と揃える。
function satelliteEntry(id: SatelliteId, name: string, color: number): { readonly name: string; create(): CelestialBody } {
  return { name, create: () => new SphereBody(id, () => createSolidSphereMesh(color), bodyDef(id).radius, MOON_VIS_DIST) };
}

export const CELESTIAL_BODIES: Record<AttractorId, { readonly name: string; create(): CelestialBody }> = {
  earth: { name: '地球', create: () => new EarthBody() },
  moon: { name: '月', create: () => new SphereBody('moon', createMoon, bodyDef('moon').radius, MOON_VIS_DIST) },
  mercury: planetEntry('mercury', '水星', mercuryTextureUrl),
  venus: planetEntry('venus', '金星', venusTextureUrl),
  mars: planetEntry('mars', '火星', marsTextureUrl),
  phobos: satelliteEntry('phobos', 'フォボス', 0x8a7a6a),
  deimos: satelliteEntry('deimos', 'ダイモス', 0x9a8a7a),
  jupiter: planetEntry('jupiter', '木星', jupiterTextureUrl),
  io: satelliteEntry('io', 'イオ', 0xd8c94a),
  europa: satelliteEntry('europa', 'エウロパ', 0xcbb8a0),
  ganymede: satelliteEntry('ganymede', 'ガニメデ', 0x8a7f73),
  callisto: satelliteEntry('callisto', 'カリスト', 0x6e6258),
  saturn: planetEntry('saturn', '土星', saturnTextureUrl),
  titan: satelliteEntry('titan', 'タイタン', 0xc8912f),
  uranus: planetEntry('uranus', '天王星', uranusTextureUrl),
  neptune: planetEntry('neptune', '海王星', neptuneTextureUrl),
  triton: satelliteEntry('triton', 'トリトン', 0xd8ccc0),
  sun: { name: '太陽', create: () => new SunBody() },
};
