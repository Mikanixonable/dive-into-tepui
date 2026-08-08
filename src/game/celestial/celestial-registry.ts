// 天体の見た目レジストリ: id から表示名と CelestialBody の生成関数を引く。
// 表示名(地球/月/太陽/木星)の定義元はここ1箇所 — 他のモジュールは必ずここを読む。
import * as THREE from 'three/webgpu';
import { AttractorId } from '../../physics/attractor';
import { bodyDef } from '../../physics/solar-system';
import { createMoon, MOON_VIS_DIST } from '../../render/stars';
import { CelestialBody } from './celestial-body';
import { EarthBody } from './earth-body';
import { SphereBody } from './sphere-body';
import { SunBody } from './sun-body';

// 木星は見た目を作り込まず、単色球で置く(テクスチャなし)。
const JUPITER_VIS_DIST = 5e7;

// 単色球のメッシュを1つ組み立てて返す。
function createJupiterMesh(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(1, 48, 24);
  const mat = new THREE.MeshStandardMaterial({ color: 0xc9a97a, roughness: 1, metalness: 0 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

export const CELESTIAL_BODIES: Record<AttractorId, { readonly name: string; create(): CelestialBody }> = {
  earth: { name: '地球', create: () => new EarthBody() },
  moon: { name: '月', create: () => new SphereBody('moon', createMoon, bodyDef('moon').radius, MOON_VIS_DIST) },
  jupiter: {
    name: '木星',
    create: () => new SphereBody('jupiter', createJupiterMesh, bodyDef('jupiter').radius, JUPITER_VIS_DIST),
  },
  sun: { name: '太陽', create: () => new SunBody() },
};
