// ゲーム内エンティティの型定義。位置・速度は ECI 座標系 [m, m/s]。
import * as THREE from 'three/webgpu';
import { OrbitState } from '../physics/orbital';
import { Attitude } from '../physics/attitude';
import { Vec3 } from '../physics/vec3';

export interface Ship {
  name: string;
  state: OrbitState;
  prevR: Vec3; // 直前サブステップの位置(弾との衝突判定用)
  att: Attitude;
  obj: THREE.Object3D;
  radius: number; // 当たり判定半径 [m]
  hp: number;
  maxHp: number;
  alive: boolean;
  lastFireSim?: number;
}

export interface Bullet {
  state: OrbitState;
  prevR: Vec3;
  bornSim: number;
  obj: THREE.Object3D;
  alive: boolean;
}

export interface PlasmaBullet {
  state: OrbitState;
  prevR: Vec3;
  bornSim: number;
  obj: THREE.Object3D;
  alive: boolean;
}


export interface Casing {
  state: OrbitState;
  att: Attitude;
  bornSim: number;
  obj: THREE.Object3D;
}

// 軌道上の補給マガジン(接近すると取り込んでベルトを延長できる)
export interface MagPickup {
  state: OrbitState;
  att: Attitude;
  obj: THREE.Object3D;
  alive: boolean;
}

export interface DebrisPiece {
  state: OrbitState;
  att: Attitude;
  obj: THREE.Object3D;
  // 物理接触(resolvePhysicalCollisions)の当たり判定半径 [m]。未設定なら
  // その破片は当たり判定を持たない(既存の爆発デブリ等はすり抜けたままでよい)。
  collideRadius?: number;
}

// 爆発・マズルフラッシュなどの一時エフェクト。
// 軌道速度で流れないよう、発生源の速度で移流させる。
export interface FlashEffect {
  mesh: THREE.Mesh;
  pos: Vec3;
  vel: Vec3;
  age: number;
  duration: number;
  size0: number;
  size1: number;
  peakOpacity: number; // 発生直後の最大不透明度倍率(ズーム中のマズルフラッシュ減光などに使う)
}
