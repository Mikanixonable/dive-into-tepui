// 時刻付き点列(KinematicState)を1本の単色折れ線として描く。保持区間が描画上限(to)に届かない
// ときは、先端を中心天体まわりの二体軌道とみなしたケプラー外挿(kepler-extrapolation.ts)で to
// まで継ぎ足す。このモジュールの責務は、DynamicTrajectory の保持区間(+ 外挿ぶん)から描画対象の
// 時刻範囲を切り出し、位置と接線を持つ節点列として Curve へ渡すことと、その曲線が描かれる
// 座標系の管理。節点の間をどう埋めるか(画面上のサジッタに応じた適応分割)は Curve が持つ。
//
// 座標変換は physics/frame.ts と、供給された座標系の剛体運動へ委譲する二段構え:
//  - bake(点列・frame が変わったときだけ): 各サンプルの KinematicState をその時刻の座標系相対へ
//    変換する(frameTransformAt→toFrameState)。点ごとに座標系の姿勢・原点が違う非剛体変形なので、
//    時刻ごとに変換し直す(慣性系なら無変換)。
//  - un-bake(毎フレーム): 表示時刻の座標系の剛体運動(frameTransformAt)を Curve の transform と
//    して与え、座標系相対頂点を慣性系へ戻す。全頂点一律なので O(1)。
//  - フローティングオリジン補正(毎フレーム): transform の位置 = 座標系原点の描画フレーム位置
//    (原点が動く座標系でもここだけ直せば済むよう、頂点は書き換えない)。
// THREE の合成は world = position + quaternion·vertex なので、原点まわりの un-bake 回転 →
// 平行移動の順で正しい。
import * as THREE from 'three/webgpu';
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { FrameAnchorSource, FrameTransform, framePoint, ReferenceFrame, toFrameState, toInertialPoint } from '../../physics/frame';
import { DynamicTrajectory, ExtrapolationCenter } from '../../physics/dynamic-trajectory';
import { extrapolatedRelativeStates } from '../../physics/kepler-extrapolation';
import { StateQueue } from '../../physics/state-queue';
import { add, Vec3 } from '../../math/vec3';
import type { CameraFrame } from '../camera/camera-frame';
import { Curve, CurveKnots } from '../curve';
import { LineStyle } from '../line-style';
import type { CelestialFrameSource } from './celestial-frame-source';

// 頂点数の打ち切り。数周ぶんの軌跡なら数百頂点で収束するが、28日表示のように数百周が
// 重なる区間は何頂点あっても収束しないので、どこで頭打ちにするかをここで決める。
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
  tip: KinematicState, center: ExtrapolationCenter, to: number,
  baseInterval: number, celestialBodies: CelestialFrameSource,
): KinematicState[] {
  const span = to - tip.t;
  const target = extrapolationTargetInterval(baseInterval, span);
  const count = Math.min(MAX_EXTRAPOLATED_SAMPLES, Math.max(2, Math.ceil(span / target)));
  return extrapolatedRelativeStates(tip, center.celestialBody, center.pivot, to, count).map((s) => {
    const centerState = celestialBodies.stateAt(center.celestialBody.id, s.t);
    return kinematicState<'eci'>(s.t, add(s.r, centerState.r), add(s.v, centerState.v));
  });
}

export class TrajectoryLine {
  private readonly curve: Curve;
  public readonly line: THREE.Object3D;
  private lastSamples: readonly KinematicState[] | null = null;
  private lastFrame: ReferenceFrame | null = null;
  private lastFrom: number | null = null;
  private lastTo: number | null = null;
  // 直近に焼き込んだ外挿区間の to。外挿を持たない bake では null に戻す — 次に外挿区間が
  // 必要になったフレームで必ず焼き直させるため。
  private lastExtrapolatedTo: number | null = null;
  private readonly unbakeQuat = new THREE.Quaternion();

  // bake 済みの frame 相対状態列。節点はここから取り、描画区間の端だけ内挿する。
  private baked = new StateQueue();
  // bake 済み列の時刻(昇順)。節点列を組み直すのに使う。
  private bakedTimes: readonly number[] = [];
  // Curve へ渡す節点列。描画区間が変わったときだけ buildKnots が組み直す。
  private knots: CurveKnots | null = null;
  // 描画区間の下限(bake 済み区間の先頭へクランプ済み)。null は下限なし(保持区間全体を描く)。
  private startTime: number | null = null;
  // 描画区間の上限(bake 済み区間の末尾へクランプ済み)。null は上限なし。
  private endTime: number | null = null;
  // 直近の sync で描いた線を慣性系へ戻す un-bake 変換。線が消えているあいだは null。
  private unbakeTransform: FrameTransform | null = null;

  // 単色の折れ線を構築する。style は最初のフレームの見た目で、以後は sync が渡す値で
  // 上書きされる(破線になるかどうかだけは、ここで渡した style の dash が決める)。
  public constructor(style: LineStyle) {
    this.curve = new Curve(style, MAX_VERTICES);
    this.line = this.curve.object;
  }

  // このフレームに描く軌跡・区間・座標系・見た目を反映する。from/to はそれぞれ描画の下限/上限
  // 時刻で、null ならその側は無制限。displayTime は un-bake に使う表示時刻(通常 simTime)。
  // trajectory が null か、描ける区間が潰れているときは線が消え、samplePoints も空になる。
  public sync(
    trajectory: DynamicTrajectory | null, from: number | null, to: number | null,
    frame: ReferenceFrame, displayTime: number, celestialBodies: CelestialFrameSource,
    frameAnchors: FrameAnchorSource, style: LineStyle, camera: CameraFrame,
  ): void {
    this.curve.setStyle(style);
    this.bakeKnots(trajectory, from, to, frame, celestialBodies, frameAnchors);
    const start = this.startTime;
    const end = this.endTime;
    const knots = this.knots;
    if (this.baked.size < 2 || start === null || end === null || start >= end || knots === null) {
      this.unbakeTransform = null;
      this.curve.clear();
      return;
    }
    // 剛体 un-bake(回転)とフローティングオリジン補正(平行移動 = 座標系原点)は、頂点を焼く
    // 前に渡す — 適応分割はこの変換を通した画面上の大きさで区間の粗さを測る。
    const tf = celestialBodies.frames.transformAt(frame, displayTime, frameAnchors);
    this.unbakeTransform = tf;
    this.unbakeQuat.set(tf.q.x, tf.q.y, tf.q.z, tf.q.w);
    this.curve.setTransform(camera.floatingOrigin.RtoThreeV3(tf.origin), this.unbakeQuat);
    this.curve.setHermiteCurve(knots, camera.camera, camera.viewport.height);
  }

  // trajectory の保持区間のうち [from, to] を、座標系相対の節点列へ焼く。区間の外は補間できない
  // ので、from/to はそれぞれ先頭/末尾へクランプする。保持区間の末尾が to に届かず、かつ先端が
  // 中心天体を持つ場合は、二体ケプラー軌道とみなして to まで外挿し継ぎ足す。
  // 座標系相対への焼き直し(frameTransformAt を伴う高コストな処理)は、保持列の参照または
  // frame が変わったときだけ行う。外挿区間を持つ間はそれに加え、to が外挿1サンプルぶんの間隔
  // 以上動いたときにも焼き直す — 動いた分がその間隔未満なら、描画末尾が最大1間隔ぶん遅れる
  // だけで見た目には出ない。
  private bakeKnots(
    trajectory: DynamicTrajectory | null, from: number | null, to: number | null, frame: ReferenceFrame,
    celestialBodies: CelestialFrameSource, frameAnchors: FrameAnchorSource,
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
        ? extrapolatedTailStates(tip!, center!, to!, trajectory!.sampleInterval, celestialBodies)
        : [];
      const combined = tail.length > 0 ? [...samples, ...tail] : samples;
      // エルミート補間は座標系に依らない (時刻, 位置, 接線) の多項式なので、座標系相対の
      // 位置と速度をそのまま KinematicState に詰めて渡す(この慣性系ブランドは関数の外へ出ない)。
      // 座標系の原点・姿勢はサンプルごとの時刻で評価する(回転系は時刻で向きが変わるため)。
      const queue = new StateQueue(Math.max(1, combined.length));
      for (const s of combined) {
        const rel = toFrameState(celestialBodies.frames.transformAt(frame, s.t, frameAnchors), s);
        queue.push(kinematicState<'eci'>(s.t, rel.r, rel.v));
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
      this.knots = this.buildKnots();
    }
  }

  // 描画区間 [startTime, endTime] に入る状態を、Curve へ渡す節点列に組む。両端は区間端で
  // 内挿した状態、間は bake 済みサンプルそのもの。
  private buildKnots(): CurveKnots | null {
    const start = this.startTime;
    const end = this.endTime;
    if (start === null || end === null || end <= start) return null;
    const times = [start, ...this.bakedTimes.filter((t) => t > start && t < end), end];
    const states = times.map((t) => this.baked.at(t)).filter((s): s is KinematicState => s !== null);
    if (states.length < 2) return null;
    const span = end - start;
    const ts: number[] = [];
    const positions: number[] = [];
    const tangents: number[] = [];
    for (const s of states) {
      ts.push((s.t - start) / span);
      positions.push(s.r.x, s.r.y, s.r.z);
      // パラメータは時刻を span で割った値なので、その微分は速度の span 倍。
      tangents.push(s.v.x * span, s.v.y * span, s.v.z * span);
    }
    return { ts, positions, tangents };
  }

  // 直近の sync で描いた線上の、当たり判定向けの ECI 絶対座標のサンプル点列を返す。
  // 線が消えているあいだは空配列。
  public samplePoints(count: number): readonly Vec3[] {
    const tf = this.unbakeTransform;
    if (tf === null) return [];
    const points: Vec3[] = [];
    const scratch = new THREE.Vector3();
    for (let i = 0; i <= count; i++) {
      this.curve.sampleAt(i / count, scratch);
      points.push(toInertialPoint(tf, framePoint(scratch.x, scratch.y, scratch.z)));
    }
    return points;
  }

  // 描画資源を解放する。以後この線は描けない。
  public dispose(): void {
    this.curve.dispose();
  }
}
