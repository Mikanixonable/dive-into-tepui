// 天体の見た目レジストリ: id から表示名と CelestialBody の生成関数を引く。
// 天体の日本語表示名の定義元はここ1箇所 — 他のモジュールは必ずここを読む。
import * as THREE from 'three/webgpu';
import { AttractorId, PlanetId } from '../../physics/attractor';
import { bodyDef } from '../../physics/solar-system';
import { createMoon, MOON_VIS_DIST } from '../../render/stars';
import { CelestialBody } from './celestial-body';
import { EarthBody } from './earth-body';
import { SphereBody } from './sphere-body';
import { SunBody } from './sun-body';

// 惑星は見た目を作り込まず、代表色の単色球で置く(テクスチャなし)。
const PLANET_VIS_DIST = 5e7;

// 半径 1 の単色球メッシュを組み立てて返す。
function createSphereMesh(color: number): THREE.Mesh {
  const geo = new THREE.SphereGeometry(1, 48, 24);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 1, metalness: 0 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

// 単色球で表示する惑星のレジストリ項を、表示名と代表色から組む。
function planetEntry(id: PlanetId, name: string, color: number): { readonly name: string; create(): CelestialBody } {
  return { name, create: () => new SphereBody(id, () => createSphereMesh(color), bodyDef(id).radius, PLANET_VIS_DIST) };
}

export const CELESTIAL_BODIES: Record<AttractorId, { readonly name: string; create(): CelestialBody }> = {
  earth: { name: '地球', create: () => new EarthBody() },
  moon: { name: '月', create: () => new SphereBody('moon', createMoon, bodyDef('moon').radius, MOON_VIS_DIST) },
  mercury: planetEntry('mercury', '水星', 0x9c9488),
  venus: planetEntry('venus', '金星', 0xd9c28a),
  mars: planetEntry('mars', '火星', 0xb5532e),
  jupiter: planetEntry('jupiter', '木星', 0xc9a97a),
  saturn: planetEntry('saturn', '土星', 0xd8b56f),
  uranus: planetEntry('uranus', '天王星', 0x9bc7cf),
  neptune: planetEntry('neptune', '海王星', 0x3f6bd6),
  sun: { name: '太陽', create: () => new SunBody() },
};
