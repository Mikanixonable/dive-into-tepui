// 点列(時刻付き KinematicState)を1本の単色折れ線として描く汎用描画基盤。OrbitLine(解析的な楕円)の
// 兄弟で、こちらは計画軌道・予測軌道・履歴軌道など「任意の点列」を折れ線化する共通土台になる。
// 頂点の解像度そのものの決定(画面上のサジッタに応じた適応分割)は render/curve.ts の Curve に
// 委ねる。このモジュールの責務は、時刻付き点列をエルミート補間で連続な曲線関数(t∈[0,1])に
// 変換して Curve へ渡すことと、その曲線が描かれる座標系の管理。
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
import { FloatingOrigin } from './floating-origin';
import { Curve, CurveDash, CurveSampler } from '../render/curve';

// 1本の折れ線が持てる頂点数。ここを超えた分は描かれない(Curve のバッファ確保上限)。
const MAX_VERTICES = 16384;

// 破線パターン。dashSize/gapSize は表示座標系の実距離 [m](Curve が LineDashedMaterial の
// lineDistance 属性へそのまま渡すため、scale=1 前提でメートルを直接渡せる)。
// 呼び出し側が毎フレーム書き換えてよい。
export type DashPattern = CurveDash;

// 空の点列。syncGeometry の再 bake 抑制は点列の参照同一性で判定するので、点列を持たない
// フレームでは呼び出し側もこの共有インスタンスを渡すこと(毎回新しい [] を作ると抑制が
// 常に外れる)。
export const EMPTY_SAMPLES: readonly KinematicState[] = [];

export class TrajectoryLine {
  private readonly curve: Curve;
  readonly line: THREE.Object3D;
  private lastSamples: readonly KinematicState[] | null = null;
  private lastFrame: ReferenceFrame | null = null;
  // Curve へ渡す revision。(samples, frame) の組が変わったときだけ新しいオブジェクトへ差し替える。
  private revision: object = {};
  private readonly unbakeQuat = new THREE.Quaternion();

  // bake 済みの frame 相対状態列。sampler クロージャがこれを参照してエルミート補間する。
  private baked: readonly KinematicState[] = [];

  // 単色の折れ線を構築する。dash を渡すと破線になる。
  constructor(color: number, opacity = 0.85, renderOrder = 2, dash?: DashPattern) {
    this.curve = new Curve({ color, opacity, renderOrder, maxVertices: MAX_VERTICES, dash });
    this.line = this.curve.object;
  }

  // t∈[0,1] を bake 済み点列の時刻範囲へ線形に写し、その時刻を挟む2点間をエルミート補間する。
  private readonly sampler: CurveSampler = (t, out) => {
    const baked = this.baked;
    const n = baked.length;
    if (n === 0) return;
    if (n === 1) { out.set(baked[0]!.r.x, baked[0]!.r.y, baked[0]!.r.z); return; }
    const time = baked[0]!.t + (baked[n - 1]!.t - baked[0]!.t) * t;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (baked[mid]!.t <= time) lo = mid; else hi = mid;
    }
    const r = hermiteInterpolate(baked[lo]!, baked[hi]!, time, true).r;
    out.set(r.x, r.y, r.z);
  };

  // (点列, frame)が前回から変わったときだけ、各サンプルを frame 相対座標へ焼き直す
  // (非剛体変形)。同じ組が続く間は、Curve 側が画面スケールの変化だけを見て再サンプリング
  // するかどうかを自分で決める。
  syncGeometry(
    samples: readonly KinematicState[], frame: ReferenceFrame, ephemeris: Ephemeris,
    attractors: readonly Attractor[],
  ): void {
    if (samples !== this.lastSamples || frame !== this.lastFrame) {
      this.lastSamples = samples;
      this.lastFrame = frame;
      this.revision = {};
      // hermiteInterpolate は座標系に依らない (時刻, 位置, 接線) の多項式なので、座標系相対の
      // 位置と速度をそのまま KinematicState に詰めて渡す(この慣性系ブランドは関数の外へ出ない)。
      // 座標系の原点・姿勢はサンプルごとの時刻で評価する(回転系は時刻で向きが変わるため)。
      this.baked = samples.map((s) => {
        const rel = toFrameState(ephemeris.frameTransformAt(frame, s.t, attractors), s);
        return kinematicState(s.t, rel.r, rel.v);
      });
    }
  }

  // 適応分割を実行し GPU バッファへ反映する。camera = 画面上のサジッタを実距離へ換算するための
  // 描画カメラ。点列が2点未満なら Curve が自然に非表示のままになる。
  sync(camera: THREE.Camera): void {
    if (this.baked.length < 2) { this.curve.setVisible(false); return; }
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

  get visible(): boolean {
    return this.curve.visible;
  }

  setDash(dashSize: number, gapSize: number): void {
    this.curve.setDash(dashSize, gapSize);
  }

  dispose(): void {
    this.curve.dispose();
  }
}
