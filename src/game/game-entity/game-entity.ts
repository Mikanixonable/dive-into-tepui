// ゲーム内エンティティの定義。位置・速度は ECI 座標系 [m, m/s]。
import * as THREE from 'three/webgpu';
import { altitudeOf, Elements, OrbitState, orbitState } from '../../physics/orbital';
import { Attitude } from '../../physics/attitude';
import { OrbitEntity } from '../../physics/orbit-entity';
import { StateQueue } from '../../physics/state-queue';
import { predictStepDt } from '../../physics/predict';
import type { Ephemeris } from '../../physics/ephemeris';
import { Vec3, len, sub, v3 } from '../../physics/vec3';
import { FloatingOrigin } from '../floating-origin';
import * as C from '../const';
import type { Stage } from '../stages/stage';
import { buildAmmo, buildBarrelMesh, buildCasingMesh, buildDebrisMesh, buildMagazineFrame } from '../../render/ships';

const identityAttitude = (): Attitude => ({
  q: { x: 0, y: 0, z: 0, w: 1 },
  w: v3(),
  inertia: v3(1, 1, 1),
});

// 軌道上を運動するゲーム内エンティティの基底。状態列の保持・前進・時刻引きそのものは
// physics/orbit-entity.ts の OrbitEntity(current)へ委ね、ここは mesh・HP・生死・姿勢・AI
// といったゲーム側の付帯情報と、種別ごとの積分パラメータ(bcInv・historyDuration)の
// 整合を持つ。collideRadius を持つものだけが剛体接触 (collision.ts) に参加する。
// scene を渡したものは自身で scene.add/remove を行う(渡さない場合は描画に
// 参加しない内部専用エンティティ — 例: BeltSection)。
export class GameEntity {
  readonly current: OrbitEntity;

  // current への転送。`.state` を読むだけの呼び出し側はこの階層化の影響を受けない。
  get state(): OrbitState { return this.current.state; }
  // 不連続な差し替え専用の口(剛体接触・反動など)。stepSim はこれを通さず current.step を
  // 直接呼ぶ — 積分による前進と外部からの上書きを、current 側は step/reset で区別する。
  set state(s: OrbitState) { this.current.reset(s); }
  get prevState(): OrbitState { return this.current.prevState; }
  get history(): StateQueue { return this.current.history; }
  // 軌道要素の計算の重複計算を防ぐメモ化(current.state の差し替えごとに破棄される)
  get elements(): Elements | null { return this.current.elements; }

  att: Attitude;
  obj: THREE.Object3D;
  alive = true;
  mass = 1; // 剛体接触の換算質量
  collideRadius?: number; // 剛体接触半径 [m]。未設定 = 剛体接触に参加しない
  thrust: Vec3 | null = null;
  // 機体座標系トルク。回転制御を持つ entity(自機は PlayerThrottle)が毎フレーム
  // 書き込み、simulator の stepAttitudes がまとめて積分する。既定ゼロ = 自由回転。
  torque: Vec3 = v3();
  // 弾道係数の逆数 Cd·A/m。stepSim の大気抵抗評価に使う自身のプロパティ(既定 0 = 抵抗なし)。
  protected readonly bcInv: number = 0;
  // 過去列の保持時間 [s]。既定 0 = 記録しない(薬莢・弾・デブリのように大量に存在する
  // ものの履歴でメモリを食い潰さないため)。Ship だけ SHIP_HISTORY_DURATION を持つ。
  protected readonly historyDuration: number = 0;
  // 予測する未来の長さ [s]。既定 0 = 予測しない(弾・薬莢・デブリ・BeltSection)。
  // Ship・Ammo だけ PREDICT_DURATION を持つ。DisplayTimeManager(「いつを見るか」)とは
  // 無関係な、エンティティ種別ごとの定数 — 表示側は予測の挙動に一切影響しない。
  protected readonly predictDuration: number = 0;
  protected readonly scene?: THREE.Scene;

  // 未来の予測列。predictDuration = 0 のクラスでは生成されない(null のまま)。
  // current と同じ OrbitEntity を使う — history が「現在〜先端の間」になるだけで
  // 構造・操作(step/at)はまったく同じ(better_predict.md §3-1)。
  private _predicted: OrbitEntity | null = null;
  get predicted(): OrbitEntity | null { return this._predicted; }
  // 積分中に再突入高度を割った、または非有限値が出て打ち切られたか。advancePrediction が
  // 新規に predicted を生成する時点で下ろす(= 作り直せば必ずもう一度試す)。
  private truncated = false;

  constructor(state: OrbitState, obj: THREE.Object3D, scene?: THREE.Scene, att: Attitude = identityAttitude()) {
    this.current = new OrbitEntity(state);
    this.att = att;
    this.obj = obj;
    this.scene = scene;
    this.scene?.add(this.obj);
  }

  // 過去列へ積む最小間隔 [s]。軌道周期から求める(1周あたり PREDICT_SAMPLES_PER_REV 点、
  // §4 の実測で補間誤差 30m 程度)。周期が取れない場合(双曲線軌道など)は
  // SHIP_HISTORY_DURATION 基準の値へフォールバックする。
  protected sampleInterval(): number {
    const period = this.elements?.period;
    if (period !== undefined && period !== null && isFinite(period) && period > 0) {
      return period / C.PREDICT_SAMPLES_PER_REV;
    }
    return C.SHIP_HISTORY_DURATION / C.PREDICT_SAMPLES_PER_REV;
  }

  // 中心重力 + 環境加速度(大気抵抗・J2・第三体摂動)+ 自身の推力で 1 ステップ RK4 積分する。
  // 死亡済みの entity は積分しない。自種別の bcInv/thrust/sampleInterval/historyDuration を
  // 揃えて current.step へ渡すのがここの責務(積分そのものは current が持つ)。
  stepSim(dt: number, sunPos: Vec3, moonPos: Vec3): void {
    if (!this.alive) return;
    this.current.step(dt, sunPos, moonPos, this.bcInv, this.thrust, this.sampleInterval(), this.historyDuration);
  }

  // 予測列を破棄するだけで、再構築はしない(Predictor.ts 参照)。次フレーム以降、通常の
  // 予算配分の中で伸び直す — 「まだ短い列」と「まだ伸びていない列」を区別しないことで、
  // 破棄が起きてもフレーム時間はスパイクしない。
  invalidatePrediction(): void {
    this._predicted = null;
  }

  // §3-4 (a) の距離判定: predicted.at(simTime) と実状態のずれが tolerance を超えていたら
  // (または predicted が保持区間外で at が null なら)予測列を破棄する。反動・剛体接触・
  // 積分差はすべてこれで拾う。GameEntity.state の setter(= current.reset)が唯一の外部
  // 書き換え口であることが、この1つの判定で漏れなく拾える根拠(stepSim は current.step を
  // 直接呼び、setter を通らない)。
  resyncPrediction(simTime: number, tolerance: number): void {
    if (this._predicted === null) return;
    const predictedState = this._predicted.at(simTime);
    if (predictedState === null || len(sub(predictedState.r, this.state.r)) > tolerance) {
      this.invalidatePrediction();
    }
  }

  // 予測列の先端を最大 budgetSteps ステップぶん伸ばし、消費したステップ数を返す
  // (予算の会計は呼び出し側 = Predictor が行う)。predicted が無ければ現在状態を種に生成する。
  advancePrediction(ephemeris: Ephemeris, budgetSteps: number, simTime: number): number {
    if (this.predictDuration <= 0) return 0;
    // 推力がかかっている間は伸ばさない: 自由飛行前提の予測は噴射中に成立せず、どうせ
    // Player.behave が即座に invalidatePrediction() するので、伸ばしても無駄になる。
    if (this.thrust !== null) return 0;
    if (this._predicted === null) {
      this._predicted = new OrbitEntity(this.current.state);
      this.truncated = false; // 生成時に下ろす
    }
    if (this.truncated) return 0;

    const p = this._predicted;
    const horizon = simTime + this.predictDuration;
    const interval = this.sampleInterval();
    let consumed = 0;
    while (consumed < budgetSteps && p.state.t < horizon - 1e-6) {
      const dt = Math.min(
        Math.max(C.PREDICT_MIN_STEP_DT, predictStepDt(len(p.state.r), this.predictDuration)),
        horizon - p.state.t,
      );
      if (dt <= 1e-9) break;
      const mid = p.state.t + dt / 2;
      const sunPos = ephemeris.sunPosAt(mid);
      const moonPos = ephemeris.moonPosAt(mid);
      p.step(dt, sunPos, moonPos, this.bcInv, null, interval, this.predictDuration);
      consumed++;

      const { r, v } = p.state;
      const finite = Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z)
        && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
      if (!finite || altitudeOf(r) < C.REENTRY_ALT) {
        this.truncated = true;
        break;
      }
    }
    return consumed;
  }

  // 毎フレームの描画位置・姿勢同期。絶対 ECI 位置(state.r)を fo 経由で描画フレームへ変換する。
  sync(fo: FloatingOrigin): void {
    this.obj.position.copy(fo.RtoThreeV3(this.state.r));
    this.obj.quaternion.set(this.att.q.x, this.att.q.y, this.att.q.z, this.att.q.w);
  }

  // playerPos は「自機からの距離」で消える種別(弾)のために一律で渡す引数。
  // 使わない派生が多数だが、消滅条件はエンティティ自身の責務なので判定はここに置く。
  checkLoss(_dt: number, _simTime: number, _activeStage: Stage, _playerPos: Vec3): void {
    if (!this.alive) return;
    if (altitudeOf(this.state.r) < C.DEBRIS_REENTRY_ALT) this.alive = false;
  }

  dispose(): void {
    this.scene?.remove(this.obj);
  }
}

export abstract class Ship extends GameEntity {
  protected readonly bcInv = C.SHIP_BCINV;
  protected readonly historyDuration = C.SHIP_HISTORY_DURATION;
  protected readonly predictDuration = C.PREDICT_DURATION;

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

// 軌道上の補給(接近すると取り込んでベルトを延長できる)
export class Ammo extends GameEntity {
  protected readonly bcInv = C.SMALL_DEBRIS_BCINV;
  protected readonly predictDuration = C.PREDICT_DURATION;

  constructor(state: OrbitState, att: Attitude, scene?: THREE.Scene) {
    super(state, buildAmmo(), scene, att);
    this.mass = 50;
    this.collideRadius = C.AMMO_PHYS_RADIUS;
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
export class DebrisPiece extends GameEntity {
  protected readonly bcInv = C.SMALL_DEBRIS_BCINV;

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

  checkLoss(dt: number, simTime: number, activeStage: Stage, playerPos: Vec3): void {
    super.checkLoss(dt, simTime, activeStage, playerPos);
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
      if (mesh.userData.ownsGeometry && mesh.geometry) {
        mesh.geometry.dispose();
      }
      if (mesh.userData.ownsMaterial && mesh.material) {
        if (Array.isArray(mesh.material)) mesh.material.forEach((m) => m.dispose());
        else mesh.material.dispose();
      }
    });
  }
}

// マガジンベルトのリンク節点を剛体接触に参加させるためのプロキシ。
// BeltPhysics が生成・保持し、機体座標系の Verlet 状態(beltPos/beltPrevPos)と
// state(ワールド ECI)の相互変換も BeltPhysics 側が担う(belt.ts 参照)。
export class BeltSection extends GameEntity {
  constructor(readonly beltIndex: number) {
    super(orbitState(0, v3(), v3()), new THREE.Object3D());
    this.mass = 5;
    this.collideRadius = 0.8;
  }
}
