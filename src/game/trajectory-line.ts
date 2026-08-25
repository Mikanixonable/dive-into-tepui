// 時刻付き点列(KinematicState)を1本の単色折れ線として描く汎用描画基盤。OrbitLine(解析的な楕円)の
// 兄弟で、こちらは計画軌道・予測軌道・履歴軌道など「DynamicTrajectory が保持する任意の点列」を
// 折れ線化する共通土台になる。保持区間が描画上限(to)に届かないときは、先端を中心天体まわりの
// 二体軌道とみなしたケプラー外挿(kepler-extrapolation.ts)で to まで継ぎ足す — 中心天体を
// 持たない列(計画軌道の各区間など)ではこの継ぎ足しは起きない。
// 頂点の解像度そのものの決定(画面上のサジッタに応じた適応分割)は render/curve.ts の Curve に
// 委ねる。このモジュールの責務は、DynamicTrajectory の保持区間(+ 外挿ぶん)から描画対象の
// 時刻範囲を切り出し、連続な曲線関数(t∈[0,1])として Curve へ渡すことと、その曲線が描かれる
// 座標系の管理。時刻から状態への内挿そのものは physics/state-queue.ts の StateQueue.at に委ねる。
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
import { KinematicState, kinematicState } from '../physics/kinematic-state';
import { FrameAnchorSource, framePoint, ReferenceFrame, toFrameState, toInertialPoint } from '../physics/frame';
import { CelestialBody } from '../physics/celestial-body';
import type { Ephemeris } from '../physics/ephemeris';
import { DynamicTrajectory } from '../physics/dynamic-trajectory';
import { extrapolatedRelativeStates } from '../physics/kepler-extrapolation';
import { StateQueue } from '../physics/state-queue';
import { add, Vec3 } from '../physics/vec3';
import { FloatingOrigin } from './floating-origin';
import { Curve, CurveSampler } from '../render/curve';
import { LineStyle } from '../render/line-style';

// 1本の折れ線が持てる頂点数。数周ぶんの軌跡なら数百頂点で収束するが、28日表示のように
// 数百周が重なる区間は何頂点あっても収束しないので、ここは「どこで頭打ちにするか」の値。
// マップの通常のズームで残留誤差が 99% の区間でサジッタ目標(0.5px)を下回る水準を採る
// (400周ぶんの軌跡の内側にカメラを置くと 1.4px ほどまで上がるが、その視点では軌跡自体が
// 画面を埋める網目になっていて見分けられない)。
const MAX_VERTICES = 4096;

// 外挿区間に足すサンプル数の上限。
const MAX_EXTRAPOLATED_SAMPLES = 2048;

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
  tip: KinematicState, center: CelestialBody, to: number, baseInterval: number, ephemeris: Ephemeris,
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

  // bake 済みの frame 相対状態列。sampler はこの列に時刻を渡すだけ。
  private baked = new StateQueue();
  // bake 済み列の時刻(昇順)。initialTs を組み直すのに使う。
  private bakedTimes: readonly number[] = [];
  // Curve の適応分割へ渡す初期頂点の t 列。サンプル自身の位置を必ず頂点にするためのもので、
  // 中身は buildInitialTs が組む。
  private initialTs: readonly number[] = [];
  // 描画区間の下限(bake 済み区間の先頭へクランプ済み)。null は下限なし(保持区間全体を描く)。
  private startTime: number | null = null;
  // 描画区間の上限(bake 済み区間の末尾へクランプ済み)。null は上限なし。
  private endTime: number | null = null;

  // 単色の折れ線を構築する。style.dash があれば破線になる。
  constructor(style: LineStyle) {
    this.curve = new Curve({ style, maxVertices: MAX_VERTICES });
    this.line = this.curve.object;
  }

  // t∈[0,1] を [startTime, endTime] の時刻範囲へ線形に写して列から引く。内挿そのものは
  // StateQueue.at が持つ — このクロージャの責務は時刻への写像だけ。
  private readonly sampler: CurveSampler = (t, out) => {
    const oldest = this.baked.oldest;
    const newest = this.baked.newest;
    if (oldest === null || newest === null) return;
    const start = this.startTime ?? oldest.t;
    const end = this.endTime ?? newest.t;
    // 写した時刻が丸めで保持範囲をわずかに外れることがあるので、引く前に列の端へ寄せる。
    const time = Math.min(newest.t, Math.max(oldest.t, start + (end - start) * t));
    const s = this.baked.at(time);
    if (s === null) return;
    out.set(s.r.x, s.r.y, s.r.z);
  };

  // trajectory の保持区間のうち [from, to] を描く対象にする。trajectory が null なら曲線を
  // 持たない状態にする。from/to はそれぞれ描画の下限/上限時刻で、null ならその側は無制限。
  // 区間の外は補間できないので、それぞれ先頭/末尾へクランプする。保持区間の末尾が to に届かず、
  // かつ先端が中心天体を持つ場合は、二体ケプラー軌道とみなして to まで外挿し継ぎ足す。
  // 座標系相対への焼き直し(frameTransformAt を伴う高コストな処理)は、保持列の参照または
  // frame が変わったときだけ行う。外挿区間を持つ間はそれに加え、to が外挿1サンプルぶんの間隔
  // 以上動いたときにも焼き直す — 動いた分がその間隔未満なら、描画末尾が最大1間隔ぶん遅れる
  // だけで見た目には出ない。
  syncGeometry(
    trajectory: DynamicTrajectory | null, from: number | null, to: number | null, frame: ReferenceFrame,
    ephemeris: Ephemeris, frameAnchors: FrameAnchorSource,
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
      const queue = new StateQueue(Math.max(1, combined.length));
      for (const s of combined) {
        const rel = toFrameState(ephemeris.frameTransformAt(frame, s.t, frameAnchors), s);
        queue.push(kinematicState(s.t, rel.r, rel.v));
      }
      this.baked = queue;
      this.bakedTimes = combined.map((s) => s.t);
      this.lastExtrapolatedTo = extrapolating ? to : null;
    }
    this.startTime = this.baked.size > 0 ? Math.max(from ?? -Infinity, this.baked.oldest!.t) : null;
    this.endTime = this.baked.size > 0 ? Math.min(to ?? Infinity, this.baked.newest!.t) : null;
    if (rebaked || from !== this.lastFrom || to !== this.lastTo) {
      this.lastFrom = from;
      this.lastTo = to;
      this.revision = {};
      this.initialTs = this.buildInitialTs();
    }
  }

  // 描画区間に入る bake 済みサンプル自身の時刻を t∈[0,1] へ写した、適応分割の初期頂点列
  // (両端を含む)。Curve は弦の中点しか見ないので、何周ぶんも入りうるこの列を等分割の初期区間
  // だけに任せると、中点がたまたま曲線に乗った区間が直線のまま残る — どこに細部があるかを
  // 知っているのは点列を持つこちら側だけなので、その位置をそのまま渡す。
  private buildInitialTs(): readonly number[] {
    const start = this.startTime;
    const end = this.endTime;
    if (start === null || end === null || end <= start) return [];
    const ts: number[] = [0];
    for (const t of this.bakedTimes) {
      const u = (t - start) / (end - start);
      if (u > 0 && u < 1) ts.push(u);
    }
    ts.push(1);
    return ts;
  }

  // 適応分割を実行し GPU バッファへ反映する。camera = 画面上のサジッタを実距離へ換算するための
  // 描画カメラ。描く区間が潰れている(bake 済み点列が2点未満、または有効な開始時刻が終了時刻
  // 以上)なら曲線を持たない状態へ戻す。
  sync(camera: THREE.Camera): void {
    const start = this.startTime;
    const end = this.endTime;
    if (this.baked.size < 2 || start === null || end === null || start >= end) {
      this.curve.clear();
      return;
    }
    this.curve.setCurve(this.sampler, { revision: this.revision, camera, initialTs: this.initialTs });
  }

  // 毎フレーム: 剛体 un-bake(回転) + フローティングオリジン補正(平行移動 = 座標系原点)。
  // currentTime = 描画時刻(通常 simTime)。
  syncTransform(
    frame: ReferenceFrame, currentTime: number, ephemeris: Ephemeris, fo: FloatingOrigin,
    frameAnchors: FrameAnchorSource,
  ): void {
    const tf = ephemeris.frameTransformAt(frame, currentTime, frameAnchors);
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

  setStyle(style: LineStyle): void {
    this.curve.setStyle(style);
  }

  setColor(color: string | number): void {
    this.curve.setColor(color);
  }

  setOpacity(opacity: number): void {
    this.curve.setOpacity(opacity);
  }

  setRenderOrder(renderOrder: number): void {
    this.curve.setRenderOrder(renderOrder);
  }

  // 直近に bake した描画区間から、当たり判定向けの ECI 絶対座標のサンプル点列を返す。
  // 座標系相対 → 慣性系の変換は表示時刻の剛体運動(syncTransform の un-bake と同じ変換)で行う。
  samplePoints(
    count: number, frame: ReferenceFrame, displayTime: number, ephemeris: Ephemeris, frameAnchors: FrameAnchorSource,
  ): readonly Vec3[] {
    const start = this.startTime;
    const end = this.endTime;
    if (this.baked.size < 2 || start === null || end === null || start >= end) return [];
    const tf = ephemeris.frameTransformAt(frame, displayTime, frameAnchors);
    const points: Vec3[] = [];
    const scratch = new THREE.Vector3();
    for (let i = 0; i <= count; i++) {
      this.sampler(i / count, scratch);
      points.push(toInertialPoint(tf, framePoint(scratch.x, scratch.y, scratch.z)));
    }
    return points;
  }

  dispose(): void {
    this.curve.dispose();
  }
}
