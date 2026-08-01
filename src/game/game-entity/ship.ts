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

  // 名前・当たり判定半径・HP を初期化し、基底の状態/メッシュ/姿勢を構築する。
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

  // 接触速度に応じた装甲ダメージを hp へ適用し、ダメージが発生したかを返す。
  // COLLISION_DAMAGE_MIN_SPEED で 0、COLLISION_DAMAGE_FULL_SPEED で maxHp ぶんの線形。
  protected applyCollisionDamage(speed: number): boolean {
    const span = C.COLLISION_DAMAGE_FULL_SPEED - C.COLLISION_DAMAGE_MIN_SPEED;
    const t = Math.min(1, Math.max(0, (speed - C.COLLISION_DAMAGE_MIN_SPEED) / span));
    if (t <= 0) return false;
    this.hp -= this.maxHp * t;
    return true;
  }

  // メッシュ配下のマテリアルを含めて破棄する。
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
