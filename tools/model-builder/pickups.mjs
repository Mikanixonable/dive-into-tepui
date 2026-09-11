// 軌道上の補給物のモデル。種類ごとに色の違うビーコンを載せる。
import * as THREE from 'three';
import { importTsDataModule } from '../compile-source.mjs';
import { buildMagazineMesh } from './gun-parts.mjs';

const { MAG_THICKNESS } = await importTsDataModule('src/physics/player-shape.ts');

// 軌道上の弾薬補給ピックアップ。マガジン数個(既定 4)とビーコンを束ねる。
export function buildAmmoPickup(count = 4) {
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

// 軌道上の RCS 燃料補給ピックアップ。弾薬と見分けやすい黄色のタンクとビーコンで構成する。
export function buildRcsFuelPickup() {
  const g = new THREE.Group();
  const tank = new THREE.Mesh(
    new THREE.CylinderGeometry(0.45, 0.45, 1.8, 10),
    new THREE.MeshStandardMaterial({ color: 0xffb347, metalness: 0.75, roughness: 0.3 }),
  );
  tank.rotation.z = Math.PI / 2;
  g.add(tank);

  const band = new THREE.Mesh(
    new THREE.TorusGeometry(0.46, 0.06, 6, 12),
    new THREE.MeshStandardMaterial({ color: 0xffe0a3, metalness: 0.8, roughness: 0.25 }),
  );
  band.rotation.y = Math.PI / 2;
  g.add(band);

  const beacon = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.28, 0),
    new THREE.MeshBasicMaterial({ color: 0xffd166 }),
  );
  beacon.position.x = 1.15;
  g.add(beacon);
  return g;
}
