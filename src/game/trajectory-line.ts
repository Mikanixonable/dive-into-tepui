// 時刻付き点列(KinematicState)を1本の単色折れ線として描く汎用描画基盤。OrbitLine(解析的な楕円)の
// 兄弟で、こちらは計画軌道・予測軌道・履歴軌道など「DynamicTrajectory が保持する任意の点列」を
// 折れ線化する共通土台になる。保持区間が描画上限(to)に届かないときは、先端を中心天体まわりの
// 二体軌道とみなしたケプラー外挿(kepler-extrapolation.ts)で to まで継ぎ足す — 中心天体を
// 持たない列(計画軌道の各区間など)ではこの継ぎ足しは起きない。
// 頂点の解像度そのものの決定(画面上のサジッタに応じた適応分割)は render/curve.ts の Curve に
// 委ねる。このモジュールの責務は、DynamicTrajectory の保持区間(+ 外挿ぶん)から描画対象の
// 時刻範囲を切り出し、エルミート補間で連続な曲線関数(t∈[0,1])に変換して Curve へ渡すことと、
// その曲線が描かれる座標系の管理。
//
// 座標変換は physics/frame.ts / physics/ephemeris.ts へ委譲する二段構え:
//  - bake(点列・frame が変わったときだけ, syncGeometry): 各サンプルの KinematicState を
//    その時刻の座標系相対へ変換する(frameTransformAt→toFrameState)。点ごとに座標系の姿勢・
//    原点が違う非剛体変形なので、時刻ごとに変換し直す(慣性系なら無変換)。
//  - un-bake(毎フレーム, syncTransform): 現在時刻 T の座標系の剛体運動(frameTransformAt)を
//    Curve の transform として与え、座標系相対頂点を慣性系へ戻す。全頂点一律なので O(1)。
//  - フローティングオリジン補正(毎フレーム): transform の位置 = 座標系原点の描画フレーム位置
//    (原点が動く座標系でもここだけ直せば済むよう、頂点は書き換えない)。
// THREE の合成は world = position + quaternion·vertex なので、原点まわりの un-bake 回転 →
// 平行移動の順で正しい。
import * as THREE from 'three/webgpu';
import { KinematicState, hermiteInterpolate, kinematicState } from '../physics/kinematic-state';
import { ReferenceFrame, toFrameState } from '../physics/frame';
import { Attractor } from '../physics/attractor';
import type { Ephemeris } from '../physics/ephemeris';
import { DynamicTrajectory } from '../physics/dynamic-trajectory';
import { extrapolatedRelativeStates } from '../physics/kepler-extrapolation';
import { add } from '../physics/vec3';
import { FloatingOrigin } from './floating-origin';
import { Curve, CurveDash, CurveSampler } from '../render/curve';

// 1本の折れ線が持てる頂点数。ここを超えた分は描かれない(Curve のバッファ確保上限)。
const MAX_VERTICES = 16384;

// 外挿区間に足すサンプル数の上限。
const MAX_EXTRAPOLATED_SAMPLES = 2048;

// 破線パターン。dashSize/gapSize は表示座標系の実距離 [m](Curve が LineDashedMaterial の
// lineDistance 属性へそのまま渡すため、scale=1 前提でメートルを直接渡せる)。
// 呼び出し側が毎フレーム書き換えてよい。
export type DashPattern = CurveDash;

// 描く軌跡が無いときの点列。再 bake するかを点列の参照同一性で判定するので、そのフレームだけ
// 空になった線が毎フレーム焼き直しにならないよう、共有インスタンスを使う。
const NO_SAMPLES: readonly KinematicState[] = [];

// 外挿区間に使う目標サンプル間隔 [s]。既存の保持列の間引き間隔(baseInterval)に合わせ、
// 履歴が空(baseInterval が 0)なら外挿する区間全体を64分割した間隔にする。
function extrapolationTargetInterval(baseInterval: number, span: number): number {
  return baseInterval > 0 ? baseInterval : span / 64;
}

// tip(保持区間の末尾)から to までを、tip を center まわりの二体ケプラー軌道とみなして外挿した
// ECI 絶対状態列(時刻昇順、tip 自身は含まない)。kepler-extrapolation.ts の返り値は center 相対
// なので、各サンプル自身の時刻における center の ECI 状態を足し戻す。離心率が高すぎる・
// 双曲線などで外挿できない場合は空配列。
function extrapolatedTailStates(
  tip: KinematicState, center: Attractor, to: number, baseInterval: number, ephemeris: Ephemeris,
): KinematicState[] {
  const span = to - tip.t;
  const target = extrapolationTargetInterval(baseInterval, span);
  const count = Math.min(MAX_EXTRAPOLATED_SAMPLES, Math.max(2, Math.ceil(span / target)));
  return extrapolatedRelativeStates(tip, center, to, count).map((s) => {
    const centerState = ephemeris.stateOf(center.id, s.t);
    return kinematicState(s.t, add(s.r, centerState.r), add(s.v, centerState.v));
  });
}

export class TrajectoryLine {
  private readonly curve: Curve;
  readonly line: THREE.Object3D;
  private lastSamples: readonly KinematicState[] | null = null;
  private lastFrame: ReferenceFrame | null = null;
  private lastFrom: number | null = null;
  private lastTo: number | null = null;
  // 直近に焼き込んだ外挿区間の to。外挿を持たない bake では null に戻す — 次に外挿区間が
  // 必要になったフレームで必ず焼き直させるため。
  private lastExtrapolatedTo: number | null = null;
  // Curve へ渡す revision。(samples, frame, from) の組が変わったときだけ新しいオブジェクトへ差し替える。
  private revision: object = {};
  private readonly unbakeQuat = new THREE.Quaternion();

  // bake 済みの frame 相対状態列。sampler クロージャがこれを参照してエルミート補間する。
  private baked: readonly KinematicState[] = [];
  // 描画区間の下限(bake 済み区間の先頭へクランプ済み)。null は下限なし(保持区間全体を描く)。
  private startTime: number | null = null;
  // 描画区間の上限(bake 済み区間の末尾へクランプ済み)。null は上限なし。
  private endTime: number | null = null;

  // 単色の折れ線を構築する。dash を渡すと破線になる。
  constructor(color: number, opacity = 0.85, renderOrder = 2, dash?: DashPattern) {
    this.curve = new Curve({ color, opacity, renderOrder, maxVertices: MAX_VERTICES, dash });
    this.line = this.curve.object;
  }

  // t∈[0,1] を [startTime, endTime] の時刻範囲へ線形に写し、その時刻を挟む2点間を
  // エルミート補間する。
  private readonly sampler: CurveSampler = (t, out) => {
    const baked = this.baked;
    const n = baked.length;
    if (n === 0) return;
    if (n === 1) { out.set(baked[0]!.r.x, baked[0]!.r.y, baked[0]!.r.z); return; }
    const start = this.startTime ?? baked[0]!.t;
    const end = this.endTime ?? baked[n - 1]!.t;
    const time = start + (end - start) * t;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (baked[mid]!.t <= time) lo = mid; else hi = mid;
    }
    const r = hermiteInterpolate(baked[lo]!, baked[hi]!, time, true).r;
    out.set(r.x, r.y, r.z);
  };

  // trajectory の保持区間のうち [from, to] を描く対象にする。保持区間の末尾が to に届かない場合、
  // 先端(trajectory.extrapolationCenter)を中心天体まわりの二体軌道とみなして to まで外挿し
  // 継ぎ足す — 中心天体を持たない、または軌道要素が求まらない(高離心率・双曲線)場合は外挿せず
  // 保持区間の末尾で止まる。trajectory が null なら曲線を持たない状態にする。from/to はそれぞれ
  // 描画の下限/上限時刻で、null ならその側は無制限(保持区間または外挿区間の端まで)。区間の外は
  // 補間できないので、それぞれ先頭/末尾へクランプする。
  // 座標系相対への焼き直し(非剛体変形、frameTransformAt を伴う高コストな処理)は、保持列の参照
  // または frame が変わったときだけ行う。外挿区間を持つ間はそれに加え、to が外挿1サンプルぶんの
  // 間隔以上動いたときだけ焼き直す — to は毎フレーム動くが、動いた分がその間隔未満なら据え置いて
  // よい(描画末尾が最大1間隔ぶん遅れるだけで見た目には出ない)。それ以外(from/to の小さな移動)は
  // 焼き直さず revision の差し替えだけで足りる。
  syncGeometry(
    trajectory: DynamicTrajectory | null, from: number | null, to: number | null, frame: ReferenceFrame,
    ephemeris: Ephemeris, attractors: readonly Attractor[],
  ): void {
    const samples = trajectory?.samplesOldestFirst() ?? NO_SAMPLES;
    const tip = samples.length > 0 ? samples[samples.length - 1]! : null;
    const center = trajectory?.extrapolationCenter ?? null;
    const extrapolating = to !== null && tip !== null && center !== null && to > tip.t;

    const rebaked = !extrapolating
      ? samples !== this.lastSamples || frame !== this.lastFrame
      : samples !== this.lastSamples || frame !== this.lastFrame || this.lastExtrapolatedTo === null
        || Math.abs(to! - this.lastExtrapolatedTo) >= extrapolationTargetInterval(trajectory!.sampleInterval, to! - tip!.t);

    if (rebaked) {
      this.lastSamples = samples;
      this.lastFrame = frame;
      const tail = extrapolating
        ? extrapolatedTailStates(tip!, center!, to!, trajectory!.sampleInterval, ephemeris)
        : [];
      const combined = tail.length > 0 ? [...samples, ...tail] : samples;
      // hermiteInterpolate は座標系に依らない (時刻, 位置, 接線) の多項式なので、座標系相対の
      // 位置と速度をそのまま KinematicState に詰めて渡す(この慣性系ブランドは関数の外へ出ない)。
      // 座標系の原点・姿勢はサンプルごとの時刻で評価する(回転系は時刻で向きが変わるため)。
      this.baked = combined.map((s) => {
        const rel = toFrameState(ephemeris.frameTransformAt(frame, s.t, attractors), s);
        return kinematicState(s.t, rel.r, rel.v);
      });
      this.lastExtrapolatedTo = extrapolating ? to : null;
    }
    this.startTime = this.baked.length > 0 ? Math.max(from ?? -Infinity, this.baked[0]!.t) : null;
    this.endTime = this.baked.length > 0 ? Math.min(to ?? Infinity, this.baked[this.baked.length - 1]!.t) : null;
    if (rebaked || from !== this.lastFrom || to !== this.lastTo) {
      this.lastFrom = from;
      this.lastTo = to;
      this.revision = {};
    }
  }

  // 適応分割を実行し GPU バッファへ反映する。camera = 画面上のサジッタを実距離へ換算するための
  // 描画カメラ。描く区間が潰れている(bake 済み点列が2点未満、または有効な開始時刻が終了時刻
  // 以上)なら曲線を持たない状態へ戻す。
  sync(camera: THREE.Camera): void {
    const baked = this.baked;
    const start = this.startTime;
    const end = this.endTime;
    if (baked.length < 2 || start === null || end === null || start >= end) {
      this.curve.clear();
      return;
    }
    this.curve.setCurve(this.sampler, { revision: this.revision, camera });
  }

  // 毎フレーム: 剛体 un-bake(回転) + フローティングオリジン補正(平行移動 = 座標系原点)。
  // currentTime = 描画時刻(通常 simTime)。
  syncTransform(
    frame: ReferenceFrame, currentTime: number, ephemeris: Ephemeris, fo: FloatingOrigin,
    attractors: readonly Attractor[],
  ): void {
    const tf = ephemeris.frameTransformAt(frame, currentTime, attractors);
    this.unbakeQuat.set(tf.q.x, tf.q.y, tf.q.z, tf.q.w);
    this.curve.setTransform(fo.RtoThreeV3(tf.origin), this.unbakeQuat);
  }

  // 表示を要求する。頂点数が2未満の間は実際には隠れたままになる。
  setVisible(v: boolean): void {
    this.curve.setVisible(v);
  }

  setDash(dashSize: number, gapSize: number): void {
    this.curve.setDash(dashSize, gapSize);
  }

  dispose(): void {
    this.curve.dispose();
  }
}
