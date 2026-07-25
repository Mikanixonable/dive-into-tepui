// 素案 B-1: 指定期間の数値予測軌道を1本の折れ線として描く、arc 単位の再利用ユニット。
// 初期状態(OrbitState)と描画区間 [start, end](絶対 simTime)を受け取り、RK4 で将来軌道点列を
// 予測(physics/predict の predictTrajectory)して、その描画は SampledLine(素案 X)へ委譲する。
//
// 「単 arc」= ノードを持たない自由伝播。plan の多ノード予測は Step 3 で B-2(PlanTrajectory)が
// arc ごとにこの B-1 を生成・所有して束ねる。B-1 自身は plan を知らないので、将来は敵機・デブリ
// の将来軌道予測にもそのまま転用できる(その用途は §6 の作業範囲外)。
//
// キャッシュ: 予測 RK4 は毎フレーム引き直すには重いので、自分の入力(初期状態・区間・サンプル数)
// の変化を検出してスロットル付きで再計算する — 初期状態/開始時刻が変わった(編集)ときは短間隔、
// end だけが simTime とともに前進する(窓が滑る)ときは長間隔。再計算した点列だけ SampledLine へ
// bake し直し、un-bake(剛体回転)とフローティングオリジン補正は毎フレーム SampledLine が行う。
//
// 環境加速度: 現状は plan 予測と同じく大気抵抗なし(predictTrajectory の bcInv=0 固定)。減衰軌道
// (敵機・デブリ)向けの弾道係数パラメータ化は、その実利用が入るとき(§5-3/§6)に predict.ts 側と
// 合わせて足す — 現consumerに不要な一般化をここで先取りしない。
import * as THREE from 'three/webgpu';
import { OrbitState } from '../../physics/orbital';
import { TrajectorySample, predictTrajectory } from '../../physics/predict';
import { Vec3, clone } from '../../physics/vec3';
import { Frame } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';
import { FloatingOrigin } from '../floating-origin';
import { SampledLine } from '../../render/sampled-line';
import * as C from '../const';

// 再計算判定に使う、前回計算時の入力スナップショット。state0 は比較用に r,v だけ控える
// (慣性系ブランドは持たない素の値でよい)。
type StateSnapshot = { r: Vec3; v: Vec3 };
type ComputeKey = { state0: StateSnapshot; start: number; end: number; maxSamples: number };

export class PredictedLine {
  private readonly sampled: SampledLine;
  private samples: TrajectorySample[] = [];
  private key: ComputeKey | null = null;
  private lastComputeMs = -Infinity;

  constructor(color: number, opacity = 0.85, renderOrder = 2) {
    this.sampled = new SampledLine(color, opacity, renderOrder);
  }

  // シーンへ追加する THREE オブジェクト(所有者が add する)。
  get object3d(): THREE.Object3D {
    return this.sampled.line;
  }

  // 毎フレーム呼ぶ。入力変化を検出してスロットル付きで予測を再計算し(重い RK4)、点列を
  // SampledLine へ bake し直す。un-bake(剛体回転)+ フローティングオリジン補正は毎フレーム行う。
  // force = true でスロットルを無視して即再計算する(表示期間切替など、窓の滑りと区別できない
  // 非連続な end 変化を呼び出し側が明示的に反映させたいとき)。
  update(
    state0: OrbitState,
    start: number,
    end: number,
    ephemeris: Ephemeris,
    frame: Frame,
    currentTime: number,
    fo: FloatingOrigin,
    maxSamples = C.PREDICT_MAX_SAMPLES,
    force = false,
  ): void {
    const edited =
      this.key === null ||
      !sameState(state0, this.key.state0) ||
      start !== this.key.start ||
      maxSamples !== this.key.maxSamples;
    const windowMoved = this.key === null || end !== this.key.end;
    if (force || edited || windowMoved) {
      const now = performance.now();
      const throttle = edited ? C.PREDICT_DIRTY_THROTTLE_MS : C.PREDICT_REFRESH_INTERVAL_MS;
      if (force || now - this.lastComputeMs >= throttle) {
        this.samples = predictTrajectory(state0, start, Math.max(0, end - start), ephemeris, maxSamples);
        this.key = { state0: { r: clone(state0.r), v: clone(state0.v) }, start, end, maxSamples };
        this.lastComputeMs = now;
      }
    }
    // bake は SampledLine 内部で (点列, frame) 変化時のみ走る。frame トグルもここで拾える。
    this.sampled.syncGeometry(this.samples, frame, ephemeris);
    this.sampled.syncTransform(frame, currentTime, ephemeris, fo);
  }

  // 予測点列の参照。B-2 の多ノード集約・クリック判定(ピッキング)が読む。
  samplesRef(): readonly TrajectorySample[] {
    return this.samples;
  }

  setVisible(v: boolean): void {
    this.sampled.setVisible(v);
  }

  dispose(): void {
    this.sampled.dispose();
  }
}

function sameState(a: StateSnapshot, b: StateSnapshot): boolean {
  return (
    a.r.x === b.r.x && a.r.y === b.r.y && a.r.z === b.r.z &&
    a.v.x === b.v.x && a.v.y === b.v.y && a.v.z === b.v.z
  );
}
