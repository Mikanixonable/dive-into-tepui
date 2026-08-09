// 天体の見た目レジストリ: id から表示名と CelestialBody の生成関数を引く。
// 天体の日本語表示名の定義元はここ1箇所 — 他のモジュールは必ずここを読む。
import * as THREE from 'three/webgpu';
import { AttractorId, PlanetId, SatelliteId } from '../../physics/attractor';
import { bodyDef } from '../../physics/solar-system';
import { createMoon, MOON_VIS_DIST } from '../../render/stars';
import { CelestialBody } from './celestial-body';
import { EarthBody } from './earth-body';
import { createSolidRing, createTexturedRing } from '../../render/ring';
import { SphereBody } from './sphere-body';
import { SunBody } from './sun-body';

import mercuryTextureUrl from '../../assets/2k_mercury.jpg';
import venusTextureUrl from '../../assets/2k_venus_atmosphere.jpg';
import marsTextureUrl from '../../assets/2k_mars.jpg';
import jupiterTextureUrl from '../../assets/2k_jupiter.jpg';
import saturnTextureUrl from '../../assets/2k_saturn.jpg';
import uranusTextureUrl from '../../assets/2k_uranus.jpg';
import neptuneTextureUrl from '../../assets/2k_neptune.jpg';
import saturnRingTextureUrl from '../../assets/2k_saturn_ring_alpha.png';

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

// テクスチャ付き惑星のレジストリ項を、表示名とテクスチャ URL から組む。buildRing を渡すと
// 環付きになる(半径は天体半径を 1 とする単位)。
function planetEntry(
  id: PlanetId,
  name: string,
  textureUrl: string,
  buildRing?: () => THREE.Object3D,
): { readonly name: string; create(): CelestialBody } {
  return {
    name,
    create: () => new SphereBody(id, () => createTexturedSphereMesh(textureUrl), bodyDef(id).radius, PLANET_VIS_DIST, buildRing),
  };
}

// 天体半径を 1 とする単位で環の半径を測るための換算。
function inRadii(id: PlanetId, meters: number): number {
  return meters / bodyDef(id).radius;
}

// 土星の環(D 環内縁 1.11 R〜A 環外縁 2.27 R)。カッシーニの間隙を含む内訳は
// テクスチャのアルファが表す。
function createSaturnRing(): THREE.Object3D {
  return createTexturedRing(saturnRingTextureUrl, 1.11, 2.27);
}

// 天王星の環(ε 環ほかを 44,000〜51,000 km の 1 枚にまとめる)。
function createUranusRing(): THREE.Object3D {
  return createSolidRing(0x8899aa, 0.25, inRadii('uranus', 4.4e7), inRadii('uranus', 5.1e7));
}

// 海王星の Adams 環(62,930 km)と Le Verrier 環(53,200 km)。実際の環幅は数十 km
// 以下で描いても見えないため、視認できる 500 km 幅へ誇張してある。
function createNeptuneRings(): THREE.Object3D {
  const group = new THREE.Group();
  for (const radius of [5.32e7, 6.293e7]) {
    group.add(createSolidRing(0x8899aa, 0.25, inRadii('neptune', radius - 2.5e5), inRadii('neptune', radius + 2.5e5)));
  }
  return group;
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

// テクスチャを持たない太陽中心天体(準惑星・大型小惑星・彗星核)のレジストリ項。表示距離は
// テクスチャ付き惑星と揃える。
function solidPlanetEntry(id: PlanetId, name: string, color: number): { readonly name: string; create(): CelestialBody } {
  return { name, create: () => new SphereBody(id, () => createSolidSphereMesh(color), bodyDef(id).radius, PLANET_VIS_DIST) };
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
  saturn: planetEntry('saturn', '土星', saturnTextureUrl, createSaturnRing),
  titan: satelliteEntry('titan', 'タイタン', 0xc8912f),
  uranus: planetEntry('uranus', '天王星', uranusTextureUrl, createUranusRing),
  neptune: planetEntry('neptune', '海王星', neptuneTextureUrl, createNeptuneRings),
  triton: satelliteEntry('triton', 'トリトン', 0xd8ccc0),
  ceres: solidPlanetEntry('ceres', 'ケレス', 0x9a938c),
  vesta: solidPlanetEntry('vesta', 'ベスタ', 0x8a8378),
  pallas: solidPlanetEntry('pallas', 'パラス', 0x7a7a72),
  pluto: solidPlanetEntry('pluto', '冥王星', 0xc9b29a),
  haumea: solidPlanetEntry('haumea', 'ハウメア', 0xcccccc),
  makemake: solidPlanetEntry('makemake', 'マケマケ', 0xb08a6a),
  eris: solidPlanetEntry('eris', 'エリス', 0xd8d8d8),
  halley: solidPlanetEntry('halley', 'ハレー彗星', 0x666666),
  encke: solidPlanetEntry('encke', 'エンケ彗星', 0x666666),
  sun: { name: '太陽', create: () => new SunBody() },
};
