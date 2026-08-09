// 天体の見た目レジストリ: id から表示名と CelestialBody の生成関数を引く。
// 天体の日本語表示名の定義元はここ1箇所 — 他のモジュールは必ずここを読む。
import * as THREE from 'three/webgpu';
import { bodyDef, CelestialRegistry, ShapeDef, SOLAR_SYSTEM, SolarSystemId } from '../../physics/solar-system';
import { AttractorId } from '../../physics/attractor';
import { createMoon, MOON_VIS_DIST } from '../../render/stars';
import { CelestialBody } from './celestial-body';
import { EarthBody } from './earth-body';
import { createSolidRing, createTexturedRing } from '../../render/ring';
import { SphereBody } from './sphere-body';
import { PointBody, PointBrightness } from './point-body';
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
// 環付きになる(半径は天体半径を 1 とする単位)。pointBrightness を渡すと戦闘ビューでの
// 表示が PointBody の輝点スプライトになる(省略時は SphereBody の視距離圧縮球のまま)。
function planetEntry(
  id: SolarSystemId,
  name: string,
  textureUrl: string,
  buildRing?: () => THREE.Object3D,
  pointBrightness?: PointBrightness,
): CelestialView {
  const buildMesh = () => createTexturedSphereMesh(textureUrl);
  const radius = bodyDef(SOLAR_SYSTEM, id).radius;
  const shape = shapeOf(id);
  return {
    name,
    create: () =>
      pointBrightness === undefined
        ? new SphereBody(id, buildMesh, radius, PLANET_VIS_DIST, buildRing, shape)
        : new PointBody(id, buildMesh, radius, pointBrightness, buildRing, shape),
  };
}

// 天体半径を 1 とする単位で環の半径を測るための換算。
function inRadii(id: SolarSystemId, meters: number): number {
  return meters / bodyDef(SOLAR_SYSTEM, id).radius;
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

// id の shape(星は持たない)。SOLAR_SYSTEM を引く箇所が皆この判別をせずに済むよう1箇所に閉じる。
function shapeOf(id: SolarSystemId): ShapeDef | undefined {
  const def = bodyDef(SOLAR_SYSTEM, id);
  return def.kind === 'star' ? undefined : def.shape;
}

// 単色の衛星のレジストリ項を、表示名と色から組む。表示距離は月と揃える。
function satelliteEntry(id: SolarSystemId, name: string, color: number): CelestialView {
  return {
    name,
    create: () => new SphereBody(id, () => createSolidSphereMesh(color), bodyDef(SOLAR_SYSTEM, id).radius, MOON_VIS_DIST, undefined, shapeOf(id)),
  };
}

// テクスチャを持たない太陽中心天体(準惑星・大型小惑星・彗星核)のレジストリ項。表示距離は
// テクスチャ付き惑星と揃える。
function solidPlanetEntry(id: SolarSystemId, name: string, color: number): CelestialView {
  return {
    name,
    create: () => new SphereBody(id, () => createSolidSphereMesh(color), bodyDef(SOLAR_SYSTEM, id).radius, PLANET_VIS_DIST, undefined, shapeOf(id)),
  };
}

export type CelestialView = { readonly name: string; create(): CelestialBody };

export const CELESTIAL_BODIES: Record<SolarSystemId, CelestialView> = {
  earth: { name: '地球', create: () => new EarthBody() },
  moon: { name: '月', create: () => new SphereBody('moon', createMoon, bodyDef(SOLAR_SYSTEM, 'moon').radius, MOON_VIS_DIST) },
  mercury: planetEntry('mercury', '水星', mercuryTextureUrl, undefined, 'medium'),
  venus: planetEntry('venus', '金星', venusTextureUrl, undefined, 'bright'),
  mars: planetEntry('mars', '火星', marsTextureUrl, undefined, 'medium'),
  phobos: satelliteEntry('phobos', 'フォボス', 0x8a7a6a),
  deimos: satelliteEntry('deimos', 'ダイモス', 0x9a8a7a),
  jupiter: planetEntry('jupiter', '木星', jupiterTextureUrl, undefined, 'bright'),
  io: satelliteEntry('io', 'イオ', 0xd8c94a),
  europa: satelliteEntry('europa', 'エウロパ', 0xcbb8a0),
  ganymede: satelliteEntry('ganymede', 'ガニメデ', 0x8a7f73),
  callisto: satelliteEntry('callisto', 'カリスト', 0x6e6258),
  saturn: planetEntry('saturn', '土星', saturnTextureUrl, createSaturnRing, 'medium'),
  titan: satelliteEntry('titan', 'タイタン', 0xc8912f),
  uranus: planetEntry('uranus', '天王星', uranusTextureUrl, createUranusRing, 'faint'),
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

// CELESTIAL_BODIES に手作りエントリを持たない id(カスタムレジストリの架空天体)向けの見た目。
// 恒星は SunBody を汎用の id/半径で構築し、それ以外は単色球にする。表示名は呼び出し側
// (frame-labels.ts の celestialBodyName)が id からフォールバックする。
export function fallbackCelestialView(registry: CelestialRegistry, id: AttractorId): CelestialBody {
  const def = bodyDef(registry, id);
  return def.kind === 'star'
    ? new SunBody(id, def.radius)
    : new SphereBody(id, () => createSolidSphereMesh(0x888888), def.radius, def.kind === 'satellite' ? MOON_VIS_DIST : PLANET_VIS_DIST);
}
