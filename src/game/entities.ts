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

// 軌道上を運動するエンティティの基底。
// collideRadius を持つものだけが剛体接触 (collision.ts) に参加する。
export class OrbitEntity {
  state: OrbitState;
  prevR: Vec3; // 直前サブステップの位置(弾との衝突判定用)
  att: Attitude;
  obj: THREE.Object3D;
  alive = true;
  mass = 1; // 剛体接触の換算質量
  collideRadius?: number; // 剛体接触半径 [m]。未設定 = 剛体接触に参加しない

  constructor(state: OrbitState, obj: THREE.Object3D, att: Attitude = identityAttitude()) {
    this.state = state;
    this.prevR = clone(state.r);
    this.att = att;
    this.obj = obj;
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
  ) {
    super(state, obj, att);
    this.name = name;
    this.radius = radius;
    this.hp = hp;
    this.maxHp = hp;
  }
}

export class Enemy extends Ship {
  accent: number; // マーカー色・集団識別。全敵が保持する
  waveId?: number; // stage00 のウェーブ敵のみ。生存ウェーブ集計に使う

  // 実行時状態(遅延初期化)。未設定 = まだその状態に入っていない
  lastTargetedSim?: number; // 最後にロックオンされた時刻。LEAD マーカー表示の履歴
  lastFireSim?: number; // 最後に発砲判定した時刻。初回は発砲タイミングをずらすため遅延初期化
  burstLeft?: number; // バースト射撃の残弾
  burstDelay?: number; // 次のバースト弾までの残り時間

  constructor(
    name: string,
    state: OrbitState,
    obj: THREE.Object3D,
    att: Attitude,
    hp: number,
    accent: number,
    waveId?: number,
  ) {
    super(name, state, obj, att, C.ENEMY_RADIUS, hp);
    this.accent = accent;
    this.waveId = waveId;
    this.mass = 10000;
    this.collideRadius = C.ENEMY_RADIUS;
    this.obj.scale.setScalar(C.ENEMY_SCALE);
  }
}

// 自弾と敵プラズマ弾の両方に使う。配列は射手(自機/敵)ごとに分けて保持し、
// 命中ルール・寿命の違いは配列単位で扱う。
export class Bullet extends OrbitEntity {
  bornSim: number;

  constructor(state: OrbitState, obj: THREE.Object3D, bornSim: number) {
    super(state, obj);
    this.bornSim = bornSim;
  }
}

export class Casing extends OrbitEntity {
  bornSim: number;

  constructor(state: OrbitState, obj: THREE.Object3D, att: Attitude, bornSim: number) {
    super(state, obj, att);
    this.bornSim = bornSim;
    this.collideRadius = 0.2;
  }
}

// 軌道上の補給マガジン(接近すると取り込んでベルトを延長できる)
export class MagPickup extends OrbitEntity {
  constructor(state: OrbitState, obj: THREE.Object3D, att: Attitude) {
    super(state, obj, att);
    this.mass = 50;
    this.collideRadius = C.MAG_PICKUP_PHYS_RADIUS;
  }
}

// collideRadius 未設定の破片(爆発デブリ等)は剛体接触に参加せずすり抜ける。
export class DebrisPiece extends OrbitEntity {
  constructor(state: OrbitState, obj: THREE.Object3D, att: Attitude, collideRadius?: number) {
    super(state, obj, att);
    this.mass = C.EJECTED_MAG_MASS;
    this.collideRadius = collideRadius;
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
