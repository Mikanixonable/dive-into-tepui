// モデルの材質の既定と、剥き出しの金属のベース色(F0)。
import * as THREE from 'three';
import { importTsDataModule } from '../compile-source.mjs';

export const { F0_ALUMINIUM, F0_BRASS, F0_BURNT_STEEL, F0_STEEL } =
  await importTsDataModule('src/render/dynamic/metal-f0.ts');

// 標準マテリアルの既定。**金属度は「その面が金属かどうか」の 0 か 1 しか取らない** —
// 塗装・セラミック・断熱材・ガラスは 0、剥き出しの金属は 1。既定は塗装面。
export function std(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    flatShading: true,
    roughness: 0.6,
    metalness: 0,
    ...opts,
  });
}
