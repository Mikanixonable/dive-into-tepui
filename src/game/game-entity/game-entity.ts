// ゲーム内エンティティの定義。位置・速度は ECI 座標系 [m, m/s]。
import * as THREE from 'three/webgpu';
import { altitudeOf, Elements, OrbitState } from '../../physics/orbital';
import { Attitude } from '../../physics/attitude';
import { OrbitEntity } from '../../physics/orbit-entity';
import { StateQueue } from '../../physics/state-queue';
import type { Ephemeris } from '../../physics/ephemeris';
import { Vec3, len, sub, v3 } from '../../physics/vec3';
import { FloatingOrigin } from '../floating-origin';
import * as C from '../const';
import type { Stage } from '../stages/stage';

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
  // public: Predictor が次ステップの刻み幅(predictStepDt)を求めるのに読む。
  readonly predictDuration: number = 0;
  protected readonly scene?: THREE.Scene;

  // 未来の予測列。predictDuration = 0 のクラスでは生成されない(null のまま)。
  // current と同じ OrbitEntity を使う — history が「現在〜先端の間」になるだけで
  // 構造・操作(step/at)はまったく同じ(better_predict.md §3-1)。
  private _predicted: OrbitEntity | null = null;
  get predicted(): OrbitEntity | null { return this._predicted; }
  // 積分中に再突入高度を割った、または非有限値が出て打ち切られたか。stepPrediction が
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

  // 予測列の先端を dt 秒ぶん1ステップだけ RK4 で伸ばし、伸ばせたら true を返す(stepSim と対になる
  // 「自種別のパラメータを揃えて1ステップ進める」責務)。dt は呼び出し側(Predictor)が
  // predictStepDt から決めて渡す — 何回呼ぶか(予算)・刻み幅の決定は Predictor 側、渡された dt で
  // 実際に1ステップ進めるかどうかはこちら側、という stepSim に対する simulationSubStep と同じ分担。
  // 伸ばせなければ(predictDuration=0・推力中・打ち切り済み・ホライズン超過のいずれか)何もせず
  // false を返す。predicted が無ければ現在状態を種に生成する。
  stepPrediction(ephemeris: Ephemeris, simTime: number, dt: number): boolean {
    if (this.predictDuration <= 0) return false;
    // 推力がかかっている間は伸ばさない: 自由飛行前提の予測は噴射中に成立せず、どうせ
    // Player.behave が即座に invalidatePrediction() するので、伸ばしても無駄になる。
    if (this.thrust !== null) return false;
    if (this._predicted === null) {
      this._predicted = new OrbitEntity(this.current.state);
      this.truncated = false; // 生成時に下ろす
    }
    if (this.truncated) return false;

    const p = this._predicted;
    const horizon = simTime + this.predictDuration;
    // dt を切り詰めて horizon ちょうどに着地させない: 切り詰めるとその1ステップだけ刻みが変わり、
    // 「horizon に追いついているかどうかで予測の解像度が変わる」という不自然な挙動になる。
    // 超えるなら素通しして false を返し、先端は horizon の一歩手前で止まる。
    if (p.state.t + dt > horizon + 1e-6) return false;

    const mid = p.state.t + dt / 2;
    const sunPos = ephemeris.sunPosAt(mid);
    const moonPos = ephemeris.moonPosAt(mid);
    p.step(dt, sunPos, moonPos, this.bcInv, null, this.sampleInterval(), this.predictDuration);

    const { r, v } = p.state;
    const finite = Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z)
      && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
    if (!finite || altitudeOf(r) < C.REENTRY_ALT) this.truncated = true;

    return true;
  }

  // 表示時刻 t の状態。過去(t <= state.t)は current.at、未来は predicted.at に委ねる —
  // 分岐はこの境界を選ぶだけで、過去・未来をまたぐ補間の継ぎ目は OrbitEntity.at 側に閉じている。
  // 予測を持たない(predicted が無い)/予測期間を超えた時刻は null。
  displayState(t: number): OrbitState | null {
    return t <= this.current.state.t ? this.current.at(t) : (this._predicted?.at(t) ?? null);
  }

  // 毎フレームの描画位置・姿勢同期。displayTime の状態(過去/未来含む)を fo 経由で描画
  // フレームへ変換する。戦闘ビューは常に displayTime === state.t を通るので挙動は変わらない。
  // displayState が無ければ(予測を持たない種別が未来表示中、または予測期間超過)非表示にする。
  sync(fo: FloatingOrigin, displayTime: number): void {
    const s = this.displayState(displayTime);
    if (s === null) {
      this.obj.visible = false;
      return;
    }
    this.obj.visible = true;
    this.obj.position.copy(fo.RtoThreeV3(s.r));
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
