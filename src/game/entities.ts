// ゲーム内エンティティの定義。位置・速度は ECI 座標系 [m, m/s]。
import * as THREE from 'three/webgpu';
import { OrbitState } from '../physics/orbital';
import { Attitude } from '../physics/attitude';
import { Vec3, clone, v3 } from '../physics/vec3';
import * as C from './const';

const identityAttitude = (): Attitude => ({
  q: { x: 0, y: 0, z: 0, w: 1 },
  w: v3(),
  inertia: v3(1, 1, 1),
});

const tmpVel = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const zAxis = new THREE.Vector3(0, 0, 1);

// 軌道上を運動するエンティティの基底。
// collideRadius を持つものだけが剛体接触 (collision.ts) に参加する。
// scene を渡したものは自身で scene.add/remove を行う(渡さない場合は描画に
// 参加しない内部専用エンティティ — 例: BeltSection)。
export class OrbitEntity {
  state: OrbitState;
  prevR: Vec3; // 直前サブステップの位置(弾との衝突判定用)
  att: Attitude;
  obj: THREE.Object3D;
  alive = true;
  mass = 1; // 剛体接触の換算質量
  collideRadius?: number; // 剛体接触半径 [m]。未設定 = 剛体接触に参加しない
  protected readonly scene?: THREE.Scene;

  constructor(state: OrbitState, obj: THREE.Object3D, scene?: THREE.Scene, att: Attitude = identityAttitude()) {
    this.state = state;
    this.prevR = clone(state.r);
    this.att = att;
    this.obj = obj;
    this.scene = scene;
    this.scene?.add(this.obj);
  }

  // 毎フレームの描画位置・姿勢同期(floating origin: origin = 自機の ECI 位置)。
  syncTransform(origin: Vec3): void {
    this.obj.position.set(this.state.r.x - origin.x, this.state.r.y - origin.y, this.state.r.z - origin.z);
    this.obj.quaternion.set(this.att.q.x, this.att.q.y, this.att.q.z, this.att.q.w);
  }

  // 寿命切れ・上限超過時に呼ばれる。既定は scene からの除去のみ。
  dispose(): void {
    this.scene?.remove(this.obj);
  }
}

export class Ship extends OrbitEntity {
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
}
// 自弾と敵プラズマ弾の両方に使う。配列は射手(自機/敵)ごとに分けて保持し、
// 命中ルール・寿命の違いは配列単位で扱う。
export class Bullet extends OrbitEntity {
  bornSim: number;

  constructor(state: OrbitState, obj: THREE.Object3D, bornSim: number, scene?: THREE.Scene) {
    super(state, obj, scene);
    this.bornSim = bornSim;
  }

  // 姿勢を持たないため、att.q ではなく自機に対する相対速度方向を向く
  // (OrbitEntity.syncTransform とはシグネチャが異なるため、別名の独自メソッドにする)。
  syncBulletTransform(origin: Vec3, playerVelocity: Vec3): void {
    this.obj.position.set(this.state.r.x - origin.x, this.state.r.y - origin.y, this.state.r.z - origin.z);
    tmpVel.set(
      this.state.v.x - playerVelocity.x,
      this.state.v.y - playerVelocity.y,
      this.state.v.z - playerVelocity.z,
    );
    if (tmpVel.lengthSq() <= 1e-6) return;
    tmpQuat.setFromUnitVectors(zAxis, tmpVel.normalize());
    this.obj.quaternion.copy(tmpQuat);
  }
}

export class Casing extends OrbitEntity {
  bornSim: number;

  constructor(state: OrbitState, obj: THREE.Object3D, att: Attitude, bornSim: number, scene?: THREE.Scene) {
    super(state, obj, scene, att);
    this.bornSim = bornSim;
    this.collideRadius = 0.2;
  }
}

// 軌道上の補給マガジン(接近すると取り込んでベルトを延長できる)
export class MagPickup extends OrbitEntity {
  constructor(state: OrbitState, obj: THREE.Object3D, att: Attitude, scene?: THREE.Scene) {
    super(state, obj, scene, att);
    this.mass = 50;
    this.collideRadius = C.MAG_PICKUP_PHYS_RADIUS;
  }
}

// collideRadius 未設定の破片(爆発デブリ等)は剛体接触に参加せずすり抜ける。
export class DebrisPiece extends OrbitEntity {
  constructor(state: OrbitState, obj: THREE.Object3D, att: Attitude, collideRadius?: number, scene?: THREE.Scene) {
    super(state, obj, scene, att);
    this.mass = C.EJECTED_MAG_MASS;
    this.collideRadius = collideRadius;
  }

  // d.obj は単一 Mesh(通常の破片)の場合と、複数子メッシュを持つ Group
  // (排出された空マガジンのフレーム等)の場合がある。traverse して
  // 見つかった Mesh すべてのジオメトリ・マテリアルを破棄する。
  dispose(): void {
    super.dispose();
    this.obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
      else mesh.material.dispose();
    });
  }
}

// マガジンベルトのリンク節点を剛体接触に参加させるためのプロキシ。
// BeltPhysics が生成・保持し、機体座標系の Verlet 状態(beltPos/beltPrevPos)と
// state(ワールド ECI)の相互変換も BeltPhysics 側が担う(belt.ts 参照)。
export class BeltSection extends OrbitEntity {
  constructor(readonly beltIndex: number) {
    super({ r: v3(), v: v3() }, new THREE.Object3D());
    this.mass = 5;
    this.collideRadius = 0.8;
  }
}
