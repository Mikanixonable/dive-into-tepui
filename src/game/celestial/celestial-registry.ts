// 天体の見た目レジストリ: id から表示名と CelestialBody の生成関数を引く。
// 天体の日本語表示名の定義元はここ1箇所 — 他のモジュールは必ずここを読む。
import * as THREE from 'three/webgpu';
import { bodyDef, CelestialRegistry, RingSystemDef, RingTextureId, ShapeDef, SOLAR_SYSTEM, SolarSystemId } from '../../physics/solar-system';
import { AttractorId } from '../../physics/attractor';
import { createMoon, MOON_VIS_DIST } from '../../render/stars';
import { CelestialBody } from './celestial-body';
import { EarthBody } from './earth-body';
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
import phobosTextureUrl from '../../assets/2k_phobos.jpg';
import ioTextureUrl from '../../assets/2k_io.jpg';
import europaTextureUrl from '../../assets/2k_europa.jpg';
import ganymedeTextureUrl from '../../assets/2k_ganymede.jpg';
import callistoTextureUrl from '../../assets/2k_callisto.jpg';
import titanTextureUrl from '../../assets/2k_titan.jpg';

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

// RingBandDef.texture の識別子から実アセット URL を引く表 — 物理データ(solar-system.ts)は
// 識別子だけを持ち、実アセットの解決はここが担う。
const RING_TEXTURES: Readonly<Record<RingTextureId, string>> = { saturn: saturnRingTextureUrl };

// テクスチャ付き惑星のレジストリ項を、表示名とテクスチャ URL から組む。rings(bodyDef から
// そのまま渡す)があれば環付きになる。pointBrightness を渡すと戦闘ビューでの表示が
// PointBody の輝点スプライトになる(省略時は SphereBody の視距離圧縮球のまま)。
function planetEntry(id: SolarSystemId, name: string, textureUrl: string, pointBrightness?: PointBrightness): CelestialView {
  const buildMesh = () => createTexturedSphereMesh(textureUrl);
  const def = bodyDef(SOLAR_SYSTEM, id);
  const rings: RingSystemDef | undefined = def.kind === 'planet' ? def.rings : undefined;
  return {
    name,
    create: () =>
      pointBrightness === undefined
        ? new SphereBody(id, buildMesh, def.radius, PLANET_VIS_DIST, shapeOf(id), rings, RING_TEXTURES)
        : new PointBody(id, buildMesh, def.radius, pointBrightness, shapeOf(id), rings, RING_TEXTURES),
  };
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
    create: () => new SphereBody(id, () => createSolidSphereMesh(color), bodyDef(SOLAR_SYSTEM, id).radius, MOON_VIS_DIST, shapeOf(id)),
  };
}

// テクスチャ付き衛星のレジストリ項を、表示名とテクスチャ URL から組む(実写の全球モザイクが
// 入手できた衛星のみ; それ以外は satelliteEntry の単色のまま)。表示距離は月と揃える。
function texturedSatelliteEntry(id: SolarSystemId, name: string, textureUrl: string): CelestialView {
  const buildMesh = () => createTexturedSphereMesh(textureUrl);
  return { name, create: () => new SphereBody(id, buildMesh, bodyDef(SOLAR_SYSTEM, id).radius, MOON_VIS_DIST, shapeOf(id)) };
}

// テクスチャを持たない太陽中心天体(準惑星・大型小惑星・彗星核)のレジストリ項。表示距離は
// テクスチャ付き惑星と揃える。
function solidPlanetEntry(id: SolarSystemId, name: string, color: number): CelestialView {
  return {
    name,
    create: () => new SphereBody(id, () => createSolidSphereMesh(color), bodyDef(SOLAR_SYSTEM, id).radius, PLANET_VIS_DIST, shapeOf(id)),
  };
}

export type CelestialView = { readonly name: string; create(): CelestialBody };

export const CELESTIAL_BODIES: Record<SolarSystemId, CelestialView> = {
  earth: { name: '地球', create: () => new EarthBody() },
  moon: { name: '月', create: () => new SphereBody('moon', createMoon, bodyDef(SOLAR_SYSTEM, 'moon').radius, MOON_VIS_DIST) },
  mercury: planetEntry('mercury', '水星', mercuryTextureUrl, 'medium'),
  venus: planetEntry('venus', '金星', venusTextureUrl, 'bright'),
  mars: planetEntry('mars', '火星', marsTextureUrl, 'medium'),
  phobos: texturedSatelliteEntry('phobos', 'フォボス', phobosTextureUrl),
  deimos: satelliteEntry('deimos', 'ダイモス', 0x9a8a7a),
  jupiter: planetEntry('jupiter', '木星', jupiterTextureUrl, 'bright'),
  io: texturedSatelliteEntry('io', 'イオ', ioTextureUrl),
  europa: texturedSatelliteEntry('europa', 'エウロパ', europaTextureUrl),
  ganymede: texturedSatelliteEntry('ganymede', 'ガニメデ', ganymedeTextureUrl),
  callisto: texturedSatelliteEntry('callisto', 'カリスト', callistoTextureUrl),
  saturn: planetEntry('saturn', '土星', saturnTextureUrl, 'medium'),
  titan: texturedSatelliteEntry('titan', 'タイタン', titanTextureUrl),
  uranus: planetEntry('uranus', '天王星', uranusTextureUrl, 'faint'),
  neptune: planetEntry('neptune', '海王星', neptuneTextureUrl),
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
