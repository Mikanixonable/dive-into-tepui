import * as THREE from 'three/webgpu';
import { Attitude } from '../../physics/attitude';
import { OrbitState } from '../../physics/orbital';
import * as C from '../const';
import { GameEntity } from './game-entity';

export abstract class Ship extends GameEntity {
  protected readonly bcInv = C.SHIP_BCINV;
  protected readonly historyDuration = C.SHIP_HISTORY_DURATION;
  readonly predictDuration = C.PREDICT_DURATION;

  name: string;
  radius: number; // 被弾判定半径 [m](剛体接触の collideRadius とは別)
  hp: number;
  maxHp: number;

  constructor(
    name: string,
    state: OrbitState,
    obj: THREE.Object3D,
    att: Attitude,
    radius: number,
    hp: number,
    scene?: THREE.Scene,
  ) {
    super(state, obj, scene, att);
    this.name = name;
    this.radius = radius;
    this.hp = hp;
    this.maxHp = hp;
  }

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
