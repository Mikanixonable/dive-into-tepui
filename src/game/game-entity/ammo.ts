import * as THREE from 'three/webgpu';
import { Attitude } from '../../physics/attitude';
import { OrbitState } from '../../physics/orbital';
import * as C from '../const';
import { buildAmmo } from '../../render/ships';
import { GameEntity } from './game-entity';

// 軌道上の補給(接近すると取り込んでベルトを延長できる)
export class Ammo extends GameEntity {
  protected readonly bcInv = C.SMALL_DEBRIS_BCINV;
  readonly predictDuration = C.PREDICT_DURATION;

  readonly id?: string;

  // 補給メッシュを組み立て、質量と衝突半径を設定する。
  constructor(state: OrbitState, att?: Attitude, scene?: THREE.Scene, id?: string) {
    super(state, buildAmmo(), scene, att, 'earth');
    this.mass = 50;
    this.collideRadius = C.AMMO_PHYS_RADIUS;
    this.id = id;
  }

  // メッシュのマテリアルも解放する。
  dispose(): void {
    super.dispose();
    this.obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
      else mesh.material.dispose();
    });
  }
}
