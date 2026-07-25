// ゲーム内エンティティの定義。位置・速度は ECI 座標系 [m, m/s]。
import * as THREE from 'three/webgpu';
import { altitudeOf, elementsFromState, ExtraAccel, OrbitState, orbitState } from '../../physics/orbital';
import { Attitude } from '../../physics/attitude';
import { Vec3, v3 } from '../../physics/vec3';
import { FloatingOrigin } from '../floating-origin';
import * as C from '../const';
import type { Stage } from '../stages/stage';
import type { Elements } from '../../physics/orbital';
import { buildAmmo, buildBarrelMesh, buildCasingMesh, buildDebrisMesh, buildMagazineFrame } from '../../render/ships';

const identityAttitude = (): Attitude => ({
  q: { x: 0, y: 0, z: 0, w: 1 },
  w: v3(),
  inertia: v3(1, 1, 1),
});

// 軌道上を運動するエンティティの基底。
// collideRadius を持つものだけが剛体接触 (collision.ts) に参加する。
// scene を渡したものは自身で scene.add/remove を行う(渡さない場合は描画に
// 参加しない内部専用エンティティ — 例: BeltSection)。
export class OrbitEntity {
  // state は不変な OrbitState の差し替えでのみ更新する。setter が軌道要素メモを破棄し、
  // 差し替え前の state を履歴へ送ることで「state と elements/history が食い違わない」保証を
  // このクラス内で完結させる(OrbitState/Vec3 が不変であることが前提 — 中身を書き換えられると
  // 検知できない)。履歴の更新を外部(積分器)に任せると、この保証が破れる。
  private _state: OrbitState;
  get state(): OrbitState { return this._state; }
  set state(s: OrbitState) {
    if (this.historyLength > 0) {
      this._history.push(this._state);
      if (this._history.length > this.historyLength) this._history.shift();
    }
    this._state = s;
    this._elements = undefined;
  }

  // 保持する過去 state の件数。0(既定) = 記録しない。1 = 直前の state だけ(弾の線分衝突判定・
  // 標的面通過判定に必要な最小限)。過去軌跡を描くならその点数まで増やす。件数を entity 種別
  // ごとに絞るのは、薬莢・破片のように大量に存在するものの履歴でメモリを食い潰さないため。
  protected readonly historyLength: number = 0;
  private readonly _history: OrbitState[] = [];

  // 古い順の過去 state 列(最大 historyLength 件)。時刻付きなので SampledLine へそのまま渡せる。
  get history(): readonly OrbitState[] { return this._history; }

  // 直前の state。履歴を持たない/まだ 1 度も進んでいない場合は現在の state を返す
  // (線分衝突判定が退化して点判定になるだけで、破綻はしない)。
  get prevState(): OrbitState { return this._history[this._history.length - 1] ?? this._state; }

  att: Attitude;
  obj: THREE.Object3D;
  alive = true;
  mass = 1; // 剛体接触の換算質量
  collideRadius?: number; // 剛体接触半径 [m]。未設定 = 剛体接触に参加しない
  thrustFn: ExtraAccel | null = null;
  // 機体座標系トルク。回転制御を持つ entity(自機は PlayerThrottle)が毎フレーム
  // 書き込み、simulator の stepAttitudes がまとめて積分する。既定ゼロ = 自由回転。
  torque: Vec3 = v3();
  protected readonly scene?: THREE.Scene;

  constructor(state: OrbitState, obj: THREE.Object3D, scene?: THREE.Scene, att: Attitude = identityAttitude()) {
    this._state = state;
    this.att = att;
    this.obj = obj;
    this.scene = scene;
    this.scene?.add(this.obj);
  }

  // 毎フレームの描画位置・姿勢同期。絶対 ECI 位置(state.r)を fo 経由で描画フレームへ変換する。
  sync(fo: FloatingOrigin): void {
    this.obj.position.copy(fo.RtoThreeV3(this.state.r));
    this.obj.quaternion.set(this.att.q.x, this.att.q.y, this.att.q.z, this.att.q.w);
  }

  checkLoss(_dt: number, _simTime: number, _activeStage: Stage): void {
    if (!this.alive) return;
    if (altitudeOf(this.state.r) < C.DEBRIS_REENTRY_ALT) this.alive = false;
  }

  dispose(): void {
    this.scene?.remove(this.obj);
  }

  // 軌道要素の計算の重複計算を防ぐメモ化(state の setter が破棄する)
  private _elements: Elements | null | undefined = undefined;
  get elements(): Elements | null {
    if (this._elements !== undefined) return this._elements;
    const el = elementsFromState(this._state.r, this._state.v);
    this._elements = el;
    return el;
  }
}

export abstract class Ship extends OrbitEntity {
  // 弾との線分衝突判定(hit.ts)が直前サブステップ位置を読むので 1 件だけ保持する。
  protected readonly historyLength = 1;

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

// 軌道上の補給(接近すると取り込んでベルトを延長できる)
export class Ammo extends OrbitEntity {
  constructor(state: OrbitState, att: Attitude, scene?: THREE.Scene) {
    super(state, buildAmmo(), scene, att);
    this.mass = 50;
    this.collideRadius = C.AMMO_PHYS_RADIUS;
  }
}

// DebrisPiece の見た目・振る舞いの種別。どの build を呼ぶか、寿命判定に何が
// 要るかをコンストラクタ/checkLoss 内部で選ぶための判別用。
export type DebrisKind =
  | { kind: 'fragment'; accent: number; size: number; }
  | { kind: 'barrel'; }
  | { kind: 'magazineFrame'; }
  | { kind: 'casing'; bornSim: number; };

function buildDebrisObj(debrisKind: DebrisKind): THREE.Object3D {
  switch (debrisKind.kind) {
    case 'fragment': return buildDebrisMesh(debrisKind.accent, debrisKind.size);
    case 'barrel': return buildBarrelMesh();
    case 'magazineFrame': return buildMagazineFrame();
    case 'casing': return buildCasingMesh();
  }
}

// collideRadius 未設定の破片(爆発デブリ等)は剛体接触に参加せずすり抜ける。
export class DebrisPiece extends OrbitEntity {
  constructor(state: OrbitState, readonly debrisKind: DebrisKind, att: Attitude, collideRadius?: number, scene?: THREE.Scene) {
    super(state, buildDebrisObj(debrisKind), scene, att);
    this.collideRadius = debrisKind.kind === 'fragment' ? undefined : collideRadius;
    switch (debrisKind.kind) {
      case 'barrel': this.mass = C.BARREL_MASS; break;
      case 'magazineFrame': this.mass = C.MAGAZINE_FRAME_MASS; break;
      case 'casing': this.mass = C.CASING_MASS; break;
      // fragmentはcollideRadius未設定であるから、衝突判定に算入せず、massは意味を持たない
      case 'fragment': this.mass = 0; break;
    }
  }

  get kind(): DebrisKind['kind'] { return this.debrisKind.kind; }

  checkLoss(dt: number, simTime: number, activeStage: Stage): void {
    super.checkLoss(dt, simTime, activeStage);
    if (!this.alive) return;
    // 薬莢のみ、寿命(CASING_LIFETIME)による消滅がある(他のデブリは大気突入のみ)。
    if (this.debrisKind.kind === 'casing' && simTime - this.debrisKind.bornSim > C.CASING_LIFETIME) {
      this.alive = false;
    }
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
    super(orbitState(0, v3(), v3()), new THREE.Object3D());
    this.mass = 5;
    this.collideRadius = 0.8;
  }
}
